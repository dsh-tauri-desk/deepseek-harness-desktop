/**
 * hydration.ts — 从 Host ledger 恢复所有已知会话的工作树状态。
 *
 * Mode selector 只在 hero composer 出现，不能承担全局状态恢复；侧边栏图标、归组、
 * 状态条和弹窗均依赖本 observer 在普通历史会话打开前完成 hydration。
 *
 * 请求模型（三级，目标是「请求量与会话数、事件数都解耦」）：
 *   1. **批量发现**：列表快照/启动时一次 `GET /bindings`（经节流器 + 在途去重）拿到全部
 *      工作树绑定与未收敛删除任务。
 *   2. **当前会话校准**：模式选择器只在当前会话渲染，切换会话时为它打一次 /status。
 *   3. **回合结束复核**：工作树会话在 `running: true → false` 边沿复核一次。
 */
import type { ClientContext } from 'dsh-tauri/client'
import type { SessionListSnapshot, WorkspaceListSnapshot, WorktreeBindings, WorktreeHydrationSessionsRuntime } from '../types'
import { createLifecycleController } from 'dsh-tauri/client'
import {
  DISCARD_MAX_POLLS,
  DISCARD_POLL_DELAY_MS,
  HANDOFF_WINDOW_MS,
  HYDRATION_MAX_RETRIES,
  HYDRATION_RETRY_BUDGET_PER_SECOND,
  HYDRATION_RETRY_DELAY_MS,
  HYDRATION_RETRY_WINDOW_MS,
  SESSION_RECONCILE_MIN_INTERVAL_MS,
} from '../constants'
import { attachWorktreeSession, discardWorktree, fetchBindings, fetchStatus } from '../service/actions'
import { openWorktreeSession } from '../service/handoff'
import { patchSession, selectSessionState, worktreeStore } from '../store'
import { createKeyedThrottle } from '../utils/throttle'

/** 批量绑定同步在节流器里占用的保留 key */
const BINDINGS_THROTTLE_KEY = '@bindings'

interface WorkspaceRuntimeMock {
  list: {
    getSnapshot: () => WorkspaceListSnapshot
    subscribe: (listener: () => void) => () => void
  }
}

/** 统一管理会话水合状态及重试机制 */
class HydrationTracker {
  switching = new Map<string, string>()
  /**
   * 归档会话集合（本次运行观察到的最后一次快照）。
   *
   * 归档会话**不参与任何检测**：不查 `/status`、不扫绑定、不挂事件订阅。这里只保留集合本身，
   * 用于识别「刚刚被归档」这一个动作边沿（见 handleArchivedSessions）。
   */
  archivedIds = new Set<string>()
  inFlight = new Set<string>()
  queued = new Set<string>()
  gitResolved = new Set<string>()
  exhausted = new Set<string>()
  lastRunning = new Map<string, boolean>()
  baselineIds = new Set<string>()
  appearedAt = new Map<string, number>()
  worktreeReconciled = new Set<string>()
  handedOff = new Set<string>()
  subscribedSessions = new Set<string>()

  /** 该会话是否已归档（归档会话一律退出检测）。 */
  isArchived(sessionId: string): boolean {
    return this.archivedIds.has(sessionId)
  }

  // 重试与轮询相关
  retryAttempts = new Map<string, number>()
  retryWindowStart = new Map<string, number>()
  discardPolls = new Map<string, { jobId: string, attempts: number }>()

  // 滑动配额
  retryWindowStartAt = 0
  retrySlotUsed = 0
  baselineCaptured = false

  clear(): void {
    this.retryAttempts.clear()
    this.retryWindowStart.clear()
    this.discardPolls.clear()
  }

  takeRetrySlot(): boolean {
    const now = Date.now()
    if (now - this.retryWindowStartAt >= 1000) {
      this.retryWindowStartAt = now
      this.retrySlotUsed = 0
    }
    if (this.retrySlotUsed >= HYDRATION_RETRY_BUDGET_PER_SECOND)
      return false
    this.retrySlotUsed += 1
    return true
  }

  withinRetryWindow(sessionId: string): boolean {
    const started = this.retryWindowStart.get(sessionId)
    return started === undefined || Date.now() - started <= HYDRATION_RETRY_WINDOW_MS
  }
}

export function registerWorktreeHydration(ctx: ClientContext): () => void {
  const sessionsRuntime = ctx.sessions as unknown as WorktreeHydrationSessionsRuntime
  const workspacesRuntime = ctx.workspaces as unknown as WorkspaceRuntimeMock

  const controller = createLifecycleController()
  const state = new HydrationTracker()

  let bindingsInFlight = false
  let knownIds = new Set<string>()
  let lastCurrent: string | undefined

  // 节流器初始化
  const reconcileThrottle = createKeyedThrottle({
    intervalMs: SESSION_RECONCILE_MIN_INTERVAL_MS,
    schedule: (fn, ms) => controller.timeout(fn, ms),
  })

  controller.add(() => reconcileThrottle.clear())
  controller.add(() => state.clear())

  const getSessionSnapshot = (): SessionListSnapshot =>
    sessionsRuntime.list.getSnapshot() as SessionListSnapshot

  const getWorkspaceSnapshot = (): WorkspaceListSnapshot =>
    workspacesRuntime.list.getSnapshot() as WorkspaceListSnapshot

  /** 轮询归档 discard 状态 */
  const scheduleDiscardPoll = (sessionId: string, jobId: string, attempts: number): void => {
    if (controller.isDisposed() || attempts >= DISCARD_MAX_POLLS)
      return
    const current = state.discardPolls.get(sessionId)
    if (current?.jobId === jobId && current.attempts >= attempts)
      return

    state.discardPolls.set(sessionId, { jobId, attempts })

    controller.timeout(async () => {
      if (controller.isDisposed())
        return
      try {
        const status = await fetchStatus(sessionId, jobId)
        if (controller.isDisposed())
          return

        if (status.mode === 'deleting' && status.jobId) {
          scheduleDiscardPoll(sessionId, status.jobId, attempts + 1)
          return
        }
        state.discardPolls.delete(sessionId)
        requestSessionReconcile(sessionId)
      }
      catch {
        scheduleDiscardPoll(sessionId, jobId, attempts + 1)
      }
    }, DISCARD_POLL_DELAY_MS)
  }

  /** 记录基线与首次出现时间 */
  const noteListBaseline = (): void => {
    if (state.baselineCaptured)
      return
    const snapshot = getSessionSnapshot()
    if (snapshot.ids.length === 0)
      return
    state.baselineCaptured = true
    snapshot.ids.forEach(id => state.baselineIds.add(id))
  }

  const noteAppearances = (): void => {
    const { ids } = getSessionSnapshot()
    const now = Date.now()
    for (const id of ids) {
      if (!state.appearedAt.has(id)) {
        state.appearedAt.set(id, now)
      }
    }
  }

  /** 有界重试调度 */
  function scheduleRetry(sessionId: string): void {
    if (controller.isDisposed())
      return
    if (!state.retryWindowStart.has(sessionId)) {
      state.retryWindowStart.set(sessionId, Date.now())
    }

    const attempts = state.retryAttempts.get(sessionId) ?? 0
    if (!state.withinRetryWindow(sessionId) || attempts >= HYDRATION_MAX_RETRIES) {
      state.retryAttempts.delete(sessionId)
      state.exhausted.add(sessionId)
      return
    }

    state.retryAttempts.set(sessionId, attempts + 1)

    if (!state.takeRetrySlot()) {
      controller.timeout(() => scheduleRetry(sessionId), HYDRATION_RETRY_DELAY_MS)
      return
    }

    controller.timeout(() => {
      if (!controller.isDisposed())
        requestGitCalibration(sessionId)
    }, HYDRATION_RETRY_DELAY_MS)
  }

  /** 发起批量同步 */
  function requestBindingsSync(): void {
    reconcileThrottle.request(BINDINGS_THROTTLE_KEY, async () => {
      if (bindingsInFlight || controller.isDisposed())
        return
      bindingsInFlight = true
      try {
        const snapshot = await fetchBindings()
        applyBindings(snapshot)
      }
      catch {
        // 宿主瞬时不可用，静默回退
      }
      finally {
        bindingsInFlight = false
      }
    })
  }

  /** 状态复位：工作树模式 → 本地模式 */
  function resetWorktreeSessionToLocal(sessionId: string, projectPath?: string): void {
    patchSession(sessionId, {
      mode: 'local',
      phase: 'idle',
      isGit: true,
      loadingLabel: '',
      log: [],
      worktreeKey: '',
      worktreePath: '',
      ...(projectPath !== undefined && { projectPath }),
      sourceSessionId: '',
      checkoutOpen: false,
      abandonOpen: false,
      error: '',
    })
  }

  /** 应用批量绑定结果 */
  function applyBindings(snapshot: WorktreeBindings): void {
    if (controller.isDisposed())
      return

    const bound = new Map(snapshot.bindings.map(b => [b.sessionId, b]))
    const jobs = new Map(snapshot.jobs.map(j => [j.sessionId, j]))

    for (const sessionId of getSessionSnapshot().ids) {
      // 归档会话不参与检测：不写状态、不触发自动交接、也不做 isGit 校准。
      if (state.isArchived(sessionId))
        continue
      const binding = bound.get(sessionId)
      if (binding) {
        patchSession(sessionId, {
          mode: 'worktree',
          phase: 'created',
          isGit: true,
          worktreeKey: binding.worktreeKey,
          worktreePath: binding.worktreePath,
          projectPath: binding.projectPath,
          sourceSessionId: binding.sourceSessionId,
          log: binding.log,
          error: '',
        })
        state.gitResolved.add(sessionId)
        state.retryAttempts.delete(sessionId)
        state.retryWindowStart.delete(sessionId)
        maybeHandoffToWorktree(sessionId, binding.sourceSessionId)
        continue
      }

      const job = jobs.get(sessionId)
      if (job) {
        patchSession(sessionId, {
          mode: 'worktree',
          phase: job.state === 'deleting' ? 'deleting' : 'error',
          error: job.error ?? '',
          worktreeKey: job.worktreeKey,
          worktreePath: job.worktreePath ?? '',
        })
        if (job.state === 'deleting') {
          scheduleDiscardPoll(sessionId, job.jobId, 0)
        }
        continue
      }

      if (selectSessionState(worktreeStore.getSnapshot(), sessionId).mode === 'worktree') {
        resetWorktreeSessionToLocal(sessionId)
      }
    }

    const { current } = getSessionSnapshot()
    if (current && !state.isArchived(current))
      requestGitCalibration(current)
  }

  function requestGitCalibration(sessionId: string): void {
    if (state.isArchived(sessionId) || state.gitResolved.has(sessionId) || state.exhausted.has(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (!state.gitResolved.has(sessionId) && !state.exhausted.has(sessionId)) {
        reconcileSession(sessionId)
      }
    })
  }

  function requestSessionReconcile(sessionId: string): void {
    if (state.isArchived(sessionId) || state.exhausted.has(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (!state.exhausted.has(sessionId) && !controller.isDisposed()) {
        reconcileSession(sessionId)
      }
    })
  }

  function requestTurnEndReconcile(sessionId: string): void {
    if (state.isArchived(sessionId) || state.exhausted.has(sessionId))
      return
    const isWorktree = selectSessionState(worktreeStore.getSnapshot(), sessionId).mode === 'worktree'
    if (!isWorktree)
      return

    reconcileThrottle.request(sessionId, () => {
      if (selectSessionState(worktreeStore.getSnapshot(), sessionId).mode === 'worktree') {
        reconcileSession(sessionId)
      }
    })
  }

  function maybeHandoffToWorktree(sessionId: string, sourceSessionId: string): void {
    if (!sourceSessionId || state.worktreeReconciled.has(sessionId))
      return
    state.worktreeReconciled.add(sessionId)

    const currentId = getSessionSnapshot().current
    const appeared = state.appearedAt.get(sessionId)
    const isFresh = !state.baselineIds.has(sessionId)
      && appeared !== undefined
      && Date.now() - appeared <= HANDOFF_WINDOW_MS

    if (!isFresh || currentId !== sourceSessionId)
      return
    if (state.handedOff.has(sourceSessionId) || state.switching.has(sourceSessionId))
      return

    state.handedOff.add(sourceSessionId)
    state.switching.set(sourceSessionId, sessionId)

    void openWorktreeSession(sessionsRuntime, sourceSessionId, sessionId, {
      isActive: () => !controller.isDisposed(),
    }).finally(() => {
      if (state.switching.get(sourceSessionId) === sessionId) {
        state.switching.delete(sourceSessionId)
      }
    })
  }

  function reconcileSession(sessionId: string): void {
    if (state.inFlight.has(sessionId)) {
      state.queued.add(sessionId)
      return
    }

    const previous = selectSessionState(worktreeStore.getSnapshot(), sessionId)
    state.inFlight.add(sessionId)

    void fetchStatus(sessionId)
      .then((status) => {
        if (controller.isDisposed())
          return

        if (status.mode === 'deleting' || status.mode === 'failed') {
          patchSession(sessionId, {
            mode: 'worktree',
            phase: status.mode === 'deleting' ? 'deleting' : 'error',
            error: status.error ?? '',
            worktreeKey: previous.worktreeKey,
            worktreePath: previous.worktreePath,
          })
          if (status.mode === 'deleting' && status.jobId) {
            scheduleDiscardPoll(sessionId, status.jobId, 0)
          }
          return
        }

        if (status.mode === 'worktree') {
          patchSession(sessionId, {
            mode: 'worktree',
            phase: 'created',
            isGit: status.isGit !== false,
            worktreeKey: status.worktreeKey ?? '',
            worktreePath: status.worktreePath ?? '',
            projectPath: status.projectPath ?? '',
            sourceSessionId: status.sourceSessionId ?? '',
            log: status.log ?? [],
          })
          state.gitResolved.add(sessionId)
          state.retryAttempts.delete(sessionId)
          state.retryWindowStart.delete(sessionId)

          if (status.sourceSessionId) {
            void attachWorktreeSession(sessionId).catch(() => {})
          }
          maybeHandoffToWorktree(sessionId, status.sourceSessionId ?? '')
          return
        }

        if (status.isGit === null) {
          scheduleRetry(sessionId)
          return
        }

        state.gitResolved.add(sessionId)
        state.retryAttempts.delete(sessionId)
        state.retryWindowStart.delete(sessionId)
        const isGit = status.isGit !== false

        if (!isGit) {
          patchSession(sessionId, {
            mode: 'local',
            phase: 'idle',
            isGit: false,
            loadingLabel: '',
            log: [],
            worktreeKey: '',
            worktreePath: '',
            projectPath: status.projectPath ?? previous.projectPath,
            sourceSessionId: '',
            checkoutOpen: false,
            abandonOpen: false,
            error: '',
          })
          return
        }

        if (previous.mode === 'worktree') {
          resetWorktreeSessionToLocal(sessionId, status.projectPath ?? previous.projectPath)
        }
        else {
          patchSession(sessionId, { isGit: true })
        }
      })
      .catch(() => scheduleRetry(sessionId))
      .finally(() => {
        state.inFlight.delete(sessionId)
        if (state.queued.delete(sessionId) && !controller.isDisposed()) {
          requestSessionReconcile(sessionId)
        }
      })
  }

  const hydrate = (): void => {
    const { ids } = getSessionSnapshot()
    const isDifferent = ids.length !== knownIds.size || ids.some(id => !knownIds.has(id))

    if (!isDifferent)
      return

    knownIds = new Set(ids)
    requestBindingsSync()
  }

  /**
   * 同步归档集合，并只在「刚刚被归档」这一动作边沿做一次收尾。
   *
   * **归档会话不参与任何检测**：不查 `/status`（含删除任务的进度轮询）、不扫绑定、不挂事件
   * 订阅、也不因为归档集合反复快照而重放。历史实现对本函数看到的每个归档会话都打一次
   * `/status`（挂载时 + 每次工作区快照），归档集合里那些宿主已不再持有的历史会话会把它放大成
   * 几十上百次请求——这正是「归档也被纳入检测」的来源；清理后又用 `pollArchivedDiscard`
   * 以 500ms 间隔轮询最多 120 次，同属对归档会话的检测。
   *
   * 现在唯一的请求是：用户**本次点击归档**的会话、且本端 store 已知它是工作树会话时，
   * 发一次 fire-and-forget 的 discard（删除由宿主后台完成，归档会话没有 UI 需要收敛，
   * 因此不轮询、不重试）。绝大多数归档会话（无工作树）连这一次请求都没有。
   */
  function handleArchivedSessions(): void {
    const nextArchived = new Set(getWorkspaceSnapshot().archivedSessionIds)
    for (const sessionId of nextArchived) {
      // 早就在归档集合里：不重放、不检测。
      if (state.archivedIds.has(sessionId))
        continue
      const local = selectSessionState(worktreeStore.getSnapshot(), sessionId)
      if (local.mode !== 'worktree' || !local.worktreeKey)
        continue
      void discardWorktree(sessionId, local.worktreeKey).catch(() => {
        // 收尾失败不重放：工作树保留在磁盘上，用户可再次归档或显式放弃。
      })
    }
    state.archivedIds = nextArchived
  }

  const bindSessionEvents = (): void => {
    const { ids } = getSessionSnapshot()
    for (const sessionId of ids) {
      // 归档会话不订阅：它们不产生需要收敛的工作树变化，订阅只会白跑回调。
      if (state.isArchived(sessionId))
        continue
      if (state.subscribedSessions.has(sessionId))
        continue
      const session = sessionsRuntime.binding(sessionId)?.session
      if (!session?.subscribe)
        continue

      state.subscribedSessions.add(sessionId)
      controller.add(session.subscribe(() => {
        if (controller.isDisposed())
          return
        const running = session.getSnapshot?.()?.running
        if (typeof running !== 'boolean') {
          requestTurnEndReconcile(sessionId)
          return
        }
        const previousRunning = state.lastRunning.get(sessionId)
        state.lastRunning.set(sessionId, running)

        if (previousRunning === true && !running) {
          requestTurnEndReconcile(sessionId)
        }
      }))
    }
  }

  // 注册订阅监听器
  const unsubscribeSessions = sessionsRuntime.list.subscribe(() => {
    noteListBaseline()
    noteAppearances()
    hydrate()
    bindSessionEvents()

    const { current } = getSessionSnapshot()
    if (current && current !== lastCurrent) {
      lastCurrent = current
      state.exhausted.delete(current)
      state.retryAttempts.delete(current)
      state.retryWindowStart.set(current, Date.now())
      if (!state.isArchived(current))
        requestGitCalibration(current)
    }
  })

  const unsubscribeWorkspaces = workspacesRuntime.list.subscribe(handleArchivedSessions)
  controller.add(unsubscribeSessions)
  controller.add(unsubscribeWorkspaces)

  // 挂载时初始化数据
  noteListBaseline()
  noteAppearances()
  // 只登记当前归档集合（此刻 store 尚未由 /bindings 填充，不会对既有归档会话发任何请求）；
  // 之后只有「用户新归档的会话」才可能触发一次收尾 discard。
  handleArchivedSessions()
  lastCurrent = getSessionSnapshot().current
  hydrate()
  bindSessionEvents()

  return () => controller.dispose()
}
