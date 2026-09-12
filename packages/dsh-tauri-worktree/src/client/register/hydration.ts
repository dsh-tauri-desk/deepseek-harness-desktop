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
  cleanedArchives = new Set<string>()
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
  // 最近一次批量绑定结果（归档清理据此判断「归档会话是否仍持有工作树」，无需逐会话查询）。
  let lastBindings: WorktreeBindings = { bindings: [], jobs: [] }
  let bindingsApplied = false

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

    lastBindings = snapshot
    bindingsApplied = true
    const bound = new Map(snapshot.bindings.map(b => [b.sessionId, b]))
    const jobs = new Map(snapshot.jobs.map(j => [j.sessionId, j]))

    for (const sessionId of getSessionSnapshot().ids) {
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
    if (current)
      requestGitCalibration(current)

    // 绑定到位后才知道哪些归档会话真的还持有工作树，此时再做归档清理：
    // 不依赖 store（归档会话通常不在客户端列表里，store 里没有它们的状态）。
    cleanupArchivedWorktrees()
  }

  function requestGitCalibration(sessionId: string): void {
    if (state.gitResolved.has(sessionId) || state.exhausted.has(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (!state.gitResolved.has(sessionId) && !state.exhausted.has(sessionId)) {
        reconcileSession(sessionId)
      }
    })
  }

  function requestSessionReconcile(sessionId: string): void {
    if (state.exhausted.has(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (!state.exhausted.has(sessionId) && !controller.isDisposed()) {
        reconcileSession(sessionId)
      }
    })
  }

  function requestTurnEndReconcile(sessionId: string): void {
    if (state.exhausted.has(sessionId))
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

  const pollArchivedDiscard = (sessionId: string, jobId: string, attempts = 0): void => {
    if (controller.isDisposed())
      return
    if (attempts >= DISCARD_MAX_POLLS) {
      state.cleanedArchives.delete(sessionId)
      return
    }
    controller.timeout(async () => {
      try {
        const status = await fetchStatus(sessionId, jobId)
        if (controller.isDisposed())
          return
        if (status.mode === 'deleting' && status.jobId) {
          pollArchivedDiscard(sessionId, status.jobId, attempts + 1)
          return
        }
        if (status.mode !== 'local')
          state.cleanedArchives.delete(sessionId)
      }
      catch {
        state.cleanedArchives.delete(sessionId)
      }
    }, DISCARD_POLL_DELAY_MS)
  }

  /**
   * 归档会话的工作树清理。
   *
   * **只用已经拿到的批量绑定判断，绝不逐归档会话打 `/status`**：归档集合可能很大，而其中
   * 的历史会话宿主往往已不再持有（`/status` 永久返回 `isGit: null`），逐会话查询会在每次
   * 工作区快照时放大成几十上百次请求——这就是「归档也被纳入检测」的来源。
   *
   * 只有「归档 **且** 仍持有工作树绑定」的会话才需要一次 discard POST，其余（绝大多数）
   * 归档会话是零请求。
   */
  function cleanupArchivedWorktrees(): void {
    // 尚未拿到绑定快照时不判定「无需清理」：否则会先把归档会话标记为已清理，
    // 等绑定到达时又跳过它们，导致工作树永久残留。
    if (!bindingsApplied)
      return
    const bound = new Map(lastBindings.bindings.map(binding => [binding.sessionId, binding]))
    for (const sessionId of getWorkspaceSnapshot().archivedSessionIds) {
      if (state.cleanedArchives.has(sessionId))
        continue

      // 本端 store 优先（覆盖刚创建/刚检出还没来得及同步绑定的情形），否则回退批量绑定。
      const local = selectSessionState(worktreeStore.getSnapshot(), sessionId)
      const worktreeKey = local.mode === 'worktree' && local.worktreeKey
        ? local.worktreeKey
        : bound.get(sessionId)?.worktreeKey
      // 无工作树绑定：没有任何东西要清理，且**不发任何请求**。
      if (!worktreeKey) {
        state.cleanedArchives.add(sessionId)
        continue
      }

      state.cleanedArchives.add(sessionId)
      void discardWorktree(sessionId, worktreeKey)
        .then((result) => {
          if (controller.isDisposed())
            return
          if (!result.ok) {
            // 允许下次绑定同步时重试（绑定同步只在会话集合变化时发生，天然有界）。
            state.cleanedArchives.delete(sessionId)
            return
          }
          if (result.jobId)
            pollArchivedDiscard(sessionId, result.jobId)
        })
        .catch(() => state.cleanedArchives.delete(sessionId))
    }
  }

  const bindSessionEvents = (): void => {
    const { ids } = getSessionSnapshot()
    for (const sessionId of ids) {
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
      requestGitCalibration(current)
    }
  })

  const unsubscribeWorkspaces = workspacesRuntime.list.subscribe(cleanupArchivedWorktrees)
  controller.add(unsubscribeSessions)
  controller.add(unsubscribeWorkspaces)

  // 挂载时初始化数据
  noteListBaseline()
  noteAppearances()
  lastCurrent = getSessionSnapshot().current
  hydrate()
  bindSessionEvents()
  // 归档清理不在挂载时执行：此刻还没有批量绑定结果，无法区分「归档且持有工作树」与
  // 「归档但无工作树」，会把前者误标记为已清理。applyBindings 拿到绑定后会自行调用。

  return () => controller.dispose()
}
