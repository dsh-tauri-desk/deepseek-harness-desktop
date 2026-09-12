/**
 * hydration.ts — 从 Host ledger 恢复所有已知会话的工作树状态。
 *
 * Mode selector 只在 hero composer 出现，不能承担全局状态恢复；侧边栏图标、归组、
 * 状态条和弹窗均依赖本 observer 在普通历史会话打开前完成 hydration。
 *
 * 启动/新建会话存在竞态（客户端列表先于宿主会话就绪）：/status 失败或返回未知
 * （isGit: null）时按固定间隔重试，直到拿到确定答案，保证「刷新才有」的工作树 UI 自愈。
 *
 * 复核触发源有两个：会话事件流（流式输出期间每秒上百次通知）与会话列表快照。二者都经
 * `SESSION_RECONCILE_MIN_INTERVAL_MS` 的 per-session 节流器合并，避免把只读 /status
 * 放大成每秒上百次请求（宿主每次还要 fork 一个 git 子进程）；窗口内最后一次请求由拖尾
 * 执行兜底，状态变化不会丢失。
 *
 * create_worktree 自动交接只允许发生在「本次运行期间新出现」的工作树会话首次复核时，
 * 且每个来源只交接一次、有时效窗口——历史遗留工作树、用户事后回到源会话、点击新建
 * 会话等场景绝不抢焦点（否则「新建会话」会被误跳到工作树会话）。
 */
import type { ClientContext } from 'dsh-tauri/client'
import type { SessionListSnapshot, WorkspaceListSnapshot, WorktreeHydrationSessionsRuntime } from '../types'
import { createLifecycleController } from 'dsh-tauri/client'
import { DISCARD_MAX_POLLS, DISCARD_POLL_DELAY_MS, HANDOFF_WINDOW_MS, HYDRATION_MAX_RETRIES, HYDRATION_RETRY_BUDGET_PER_SECOND, HYDRATION_RETRY_DELAY_MS, HYDRATION_RETRY_WINDOW_MS, SESSION_RECONCILE_MIN_INTERVAL_MS } from '../constants'
import { attachWorktreeSession, discardWorktree, fetchStatus } from '../service/actions'
import { openWorktreeSession } from '../service/handoff'
import { patchSession, selectSessionState, worktreeStore } from '../store'
import { createKeyedThrottle } from '../utils/throttle'

export function registerWorktreeHydration(ctx: ClientContext): () => void {
  // HARDCODE: SessionRuntime.binding() is an internal DSH 0.1.1-rc.2 API.
  // The public session-list source does not emit every tool-event mutation, so
  // live checkout/discard reconciliation subscribes to the bound Session source.
  const sessionsRuntime = ctx.sessions as unknown as WorktreeHydrationSessionsRuntime
  // alpha 下 workspacesRuntime.list 为宿主服务面（SessionStore/WorkspaceController 差异），
  // 投影到本地只读快照契约（archivedSessionIds 归组清理）。
  const workspacesRuntime = ctx.workspaces as unknown as {
    list: { getSnapshot: () => WorkspaceListSnapshot, subscribe: (listener: () => void) => () => void }
  }
  const controller = createLifecycleController()
  const seen = new Set<string>()
  const switching = new Map<string, string>()
  const cleanedArchives = new Set<string>()
  const inFlight = new Set<string>()
  const queued = new Set<string>()
  const retryAttempts = new Map<string, number>()
  // 重试预算耗尽（宿主始终解析不出该会话）：永久退出列表驱动的复核，避免会话数放大请求量。
  const exhausted = new Set<string>()
  // 未解析会话的重试窗口起点（与会话「出现时间」分开：后者还兼任自动交接的时效判定，
  // 不能被重试逻辑改写，否则历史会话会被误判成「本次运行新出现」而抢焦点）。
  const retryWindowStart = new Map<string, number>()
  // 未解析会话的全局重试配额（滑动秒窗）：让聚合速率与会话数解耦。
  let retryWindowStartAt = 0
  let retrySlotUsed = 0
  let lastCurrent: string | undefined
  // 插件安装时的会话基线：基线内的工作树会话是历史遗留，绝不自动交接。
  let baselineCaptured = false
  const baselineIds = new Set<string>()
  // 会话首次出现在列表的时间（用于限定交接时效窗口）。
  const appearedAt = new Map<string, number>()
  // 已建立过 worktree 状态的会话：自动交接只允许发生在「第一次」复核成功时，
  // 事件流/重试触发的后续复核只负责 checkout/discard 状态对齐，不再抢焦点。
  const worktreeReconciled = new Set<string>()
  // 已完成自动交接的来源会话：一次交接后永久不再抢（区别于 switching 的在途标记）。
  const handedOff = new Set<string>()
  // 已绑定过 Session source 的会话（bindSessionEvents 去重）。
  const subscribedSessions = new Set<string>()
  const discardPolls = new Map<string, { jobId: string, attempts: number }>()
  // 复核节流器：定时器登记进 controller，卸载时随 dispose 一并清理。
  const reconcileThrottle = createKeyedThrottle({
    intervalMs: SESSION_RECONCILE_MIN_INTERVAL_MS,
    schedule: (fn, ms) => controller.timeout(fn, ms),
  })
  controller.add(() => reconcileThrottle.clear())
  controller.add(() => {
    retryAttempts.clear()
    retryWindowStart.clear()
    discardPolls.clear()
  })

  const scheduleDiscardPoll = (sessionId: string, jobId: string, attempts: number): void => {
    if (controller.isDisposed() || attempts >= DISCARD_MAX_POLLS)
      return
    const current = discardPolls.get(sessionId)
    if (current?.jobId === jobId && current.attempts >= attempts)
      return
    discardPolls.set(sessionId, { jobId, attempts })
    controller.timeout(() => {
      if (controller.isDisposed())
        return
      void fetchStatus(sessionId, jobId)
        .then((status) => {
          if (controller.isDisposed())
            return
          if (status.mode === 'deleting' && status.jobId) {
            scheduleDiscardPoll(sessionId, status.jobId, attempts + 1)
            return
          }
          discardPolls.delete(sessionId)
          // 删除任务刚结束：立即复核，不等节流窗口（一次性收敛，不参与高频路径）。
          reconcileSession(sessionId)
        })
        .catch(() => scheduleDiscardPoll(sessionId, jobId, attempts + 1))
    }, DISCARD_POLL_DELAY_MS)
  }

  /**
   * 捕获插件安装基线：等第一个非空列表快照（应用启动时列表 RPC 可能尚未返回，
   * 空快照不能当基线，否则启动期已存在的工作树会话会被误判为「新出现」）。
   */
  const noteListBaseline = (): void => {
    if (baselineCaptured)
      return
    const snapshot = sessionsRuntime.list.getSnapshot() as SessionListSnapshot
    if (snapshot.ids.length === 0)
      return
    baselineCaptured = true
    for (const sessionId of snapshot.ids)
      baselineIds.add(sessionId)
  }

  /** 记录会话首次出现在列表的时间（交接时效窗口的起点）。 */
  const noteAppearances = (): void => {
    const snapshot = sessionsRuntime.list.getSnapshot() as SessionListSnapshot
    const now = Date.now()
    for (const sessionId of snapshot.ids) {
      if (!appearedAt.has(sessionId))
        appearedAt.set(sessionId, now)
    }
  }

  /**
   * 请求失败或宿主返回「未知」（isGit: null，会话尚未就绪）时按固定间隔重试。
   * 启动/新建会话存在竞态：客户端列表已出现会话而宿主尚无 header.cwd，一次失败后
   * 若只等列表事件，可能永远不再触发（列表已稳定），工作树 UI 就停留在「刷新才有」。
   *
   * 但「未知」也可能是**永久**的：会话列表里长期存在宿主已不再持有的历史会话（换过机器、
   * 会话目录被清理等），它们永远不会解析成功。此时重试必须收敛，否则聚合速率随会话数
   * 线性增长——这正是 /status 请求风暴的放大器。因此重试同时受三重约束：
   *   1. 只在会话「出现后的短窗口」内重试（启动竞态只需数秒）；
   *   2. 全局每秒配额（会话可能有几十上百个，不能让它们各自独立重试）；
   *   3. 单会话次数上限。
   * 任一约束耗尽即标记 exhausted，永久退出复核（用户打开该会话时再重新校准一次）。
   */
  function scheduleRetry(sessionId: string): void {
    if (controller.isDisposed())
      return
    if (!retryWindowStart.has(sessionId))
      retryWindowStart.set(sessionId, Date.now())
    if (!withinRetryWindow(sessionId) || (retryAttempts.get(sessionId) ?? 0) >= HYDRATION_MAX_RETRIES) {
      retryAttempts.delete(sessionId)
      exhausted.add(sessionId)
      return
    }
    // 全局配额不足时只顺延、不消耗次数：配额由所有未解析会话共享，聚合速率因此有上界。
    if (!takeRetrySlot()) {
      controller.timeout(() => scheduleRetry(sessionId), HYDRATION_RETRY_DELAY_MS)
      return
    }
    retryAttempts.set(sessionId, (retryAttempts.get(sessionId) ?? 0) + 1)
    controller.timeout(() => {
      if (controller.isDisposed())
        return
      requestEventReconcile(sessionId)
    }, HYDRATION_RETRY_DELAY_MS)
  }

  /** 会话是否仍处于重试窗口内（窗口外说明不是启动竞态，继续重试无意义）。 */
  function withinRetryWindow(sessionId: string): boolean {
    const started = retryWindowStart.get(sessionId)
    return started === undefined || Date.now() - started <= HYDRATION_RETRY_WINDOW_MS
  }

  /** 领取一次全局重试配额（滑动秒窗），配额耗尽返回 false。 */
  function takeRetrySlot(): boolean {
    const now = Date.now()
    if (now - retryWindowStartAt >= 1000) {
      retryWindowStartAt = now
      retrySlotUsed = 0
    }
    if (retrySlotUsed >= HYDRATION_RETRY_BUDGET_PER_SECOND)
      return false
    retrySlotUsed += 1
    return true
  }

  /**
   * 列表快照驱动的复核：只补「从未复核过」的会话。
   *
   * 已解析的会话（含工作树模式）不在本路径复核——工作树会话由**自身事件流**驱动复核
   * （见 requestEventReconcile），宿主解析不出的历史会话则被 exhausted 排除。
   * 若这里放行「已复核但未解析」的会话，会话列表每次变化都会为列表里每个这样的会话
   * 重新发起一轮请求，请求速率随会话数增长，就是本次 /status 风暴的根因。
   */
  function requestHydrateReconcile(sessionId: string): void {
    if (seen.has(sessionId) || exhausted.has(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (!seen.has(sessionId) && !exhausted.has(sessionId))
        reconcileSession(sessionId)
    })
  }

  /**
   * 会话事件流驱动的复核：该会话自身事件流变化时才复核。
   *   - 尚未解析成功：事件到达说明会话已在宿主侧活跃，值得补一次（限额见 scheduleRetry）；
   *   - 处于工作树模式：Agent 可能刚调用 checkout_worktree / discard_worktree，需对齐回本地。
   * 已放弃（exhausted）的会话不再因事件反复重试；用户主动打开时会重新校准。
   */
  function requestEventReconcile(sessionId: string): void {
    if (!needsEventReconcile(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (needsEventReconcile(sessionId))
        reconcileSession(sessionId)
    })
  }

  function needsEventReconcile(sessionId: string): boolean {
    if (exhausted.has(sessionId))
      return false
    if (!seen.has(sessionId))
      return true
    return selectSessionState(worktreeStore.getSnapshot(), sessionId).mode === 'worktree'
  }

  function reconcileSession(sessionId: string): void {
    if (inFlight.has(sessionId)) {
      queued.add(sessionId)
      return
    }
    const previous = selectSessionState(worktreeStore.getSnapshot(), sessionId)
    seen.add(sessionId)
    inFlight.add(sessionId)
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
          if (status.mode === 'deleting' && status.jobId)
            scheduleDiscardPoll(sessionId, status.jobId, 0)
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
          retryAttempts.delete(sessionId)
          retryWindowStart.delete(sessionId)
          // 自愈旧 ledger 会话：Desktop workspace 补丁允许显式归属到源 Workspace。
          if (status.sourceSessionId)
            void attachWorktreeSession(sessionId).catch(() => {})
          // create_worktree 工具在 Host 先发布继承上下文的新根会话；它进入列表后，
          // 客户端把当前源会话视觉交接到该工作树会话（不启动额外模型 turn）。
          // 触发必须同时满足：首次复核成功、会话是本次运行期间新出现（基线外且未过
          // 时效窗口）、当前仍在源会话、且该来源尚未交接过——否则会在「查看源会话」或
          // 「新建会话」流程中误抢焦点（跳到工作树会话，导致无法新建会话）。
          if (!worktreeReconciled.has(sessionId)) {
            worktreeReconciled.add(sessionId)
            const currentId = sessionsRuntime.list.getSnapshot().current
            const sourceSessionId = status.sourceSessionId
            const appeared = appearedAt.get(sessionId)
            const fresh = !baselineIds.has(sessionId)
              && appeared !== undefined
              && Date.now() - appeared <= HANDOFF_WINDOW_MS
            if (sourceSessionId && fresh && currentId === sourceSessionId
              && !handedOff.has(sourceSessionId) && !switching.has(sourceSessionId)) {
              handedOff.add(sourceSessionId)
              switching.set(sourceSessionId, sessionId)
              void openWorktreeSession(sessionsRuntime, sourceSessionId, sessionId, {
                isActive: () => !controller.isDisposed(),
              })
                .finally(() => {
                  if (switching.get(sourceSessionId) === sessionId)
                    switching.delete(sourceSessionId)
                })
            }
          }
          return
        }
        // 未知状态（宿主尚无该会话的 cwd，新建/启动竞态）：不写入任何状态——保持
        // 默认 git 假设与用户已选模式（选择器可见），交由 scheduleRetry 的有界重试链
        // 收敛（窗口 + 全局配额 + 次数上限，见该函数注释）。绝不把 seen 清掉换「列表事件
        // 重新拉起」——宿主永久解析不出的历史会话会让请求量随会话数放大。
        if (status.isGit === null) {
          scheduleRetry(sessionId)
          return
        }
        retryAttempts.delete(sessionId)
        retryWindowStart.delete(sessionId)
        const isGit = status.isGit !== false
        // 非 git 目录：永远只能是本地模式，且隐藏工作树模式选择器（select 据此渲染）。
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
          patchSession(sessionId, {
            mode: 'local',
            phase: 'idle',
            isGit: true,
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
        }
        else {
          patchSession(sessionId, { isGit: true })
        }
      })
      .catch(() => {
        // 状态接口失败（宿主路由尚未就绪、会话瞬时不可寻址等）不应影响普通会话；
        // 交给 scheduleRetry 的有界重试链自愈。
        // 注意：不能从 seen 移除——seen 现在表示「已尝试过」，移除会让会话列表的每次
        // 变化都为该会话重新发起请求，请求量随会话数放大（本次 /status 风暴的根因）。
        scheduleRetry(sessionId)
      })
      .finally(() => {
        inFlight.delete(sessionId)
        // 请求在途期间又到达复核请求：立即补一次（不经节流器，避免丢掉在途期间的变更）；
        // 该路径被 inFlight 串行化，稳态下每个窗口至多补一次。
        if (queued.delete(sessionId) && !controller.isDisposed())
          reconcileSession(sessionId)
      })
  }

  // 列表快照驱动的复核只补「从未复核过」的会话（详见 requestHydrateReconcile）：
  // 快照在流式输出期间持续变化，若把已解析/已放弃的会话也放进来，请求量会随会话数放大。
  const hydrate = (): void => {
    const snapshot = sessionsRuntime.list.getSnapshot() as SessionListSnapshot
    for (const sessionId of snapshot.ids) requestHydrateReconcile(sessionId)
  }

  const pollArchivedDiscard = (sessionId: string, jobId: string, attempts = 0): void => {
    if (controller.isDisposed())
      return
    if (attempts >= DISCARD_MAX_POLLS) {
      cleanedArchives.delete(sessionId)
      return
    }
    controller.timeout(() => {
      void fetchStatus(sessionId, jobId)
        .then((status) => {
          if (controller.isDisposed())
            return
          if (status.mode === 'deleting' && status.jobId) {
            pollArchivedDiscard(sessionId, status.jobId, attempts + 1)
            return
          }
          // local: the cleanup settled while polling. worktree: the Host lost
          // the job (restart) — clear the guard so the next snapshot retries.
          if (status.mode !== 'local')
            cleanedArchives.delete(sessionId)
        })
        .catch(() => cleanedArchives.delete(sessionId))
    }, DISCARD_POLL_DELAY_MS)
  }

  // 原生侧栏「归档」只隐藏会话。若该会话绑定工作树，归档集合变化后补做
  // worktree/owned branch/ledger 清理；会话日志仍由 DSH 归档持久化保留。
  const cleanupArchivedWorktrees = (): void => {
    const snapshot = workspacesRuntime.list.getSnapshot() as WorkspaceListSnapshot
    for (const sessionId of snapshot.archivedSessionIds) {
      if (cleanedArchives.has(sessionId))
        continue
      cleanedArchives.add(sessionId)
      void fetchStatus(sessionId)
        .then((status) => {
          if (controller.isDisposed() || status.mode !== 'worktree')
            return
          return discardWorktree(sessionId, status.worktreeKey ?? '').then((result) => {
            if (!result.ok)
              cleanedArchives.delete(sessionId)
            else if (result.jobId)
              pollArchivedDiscard(sessionId, result.jobId)
          })
        })
        .catch(() => {
          // 网络/Host 暂不可用时允许下次快照重试。
          cleanedArchives.delete(sessionId)
        })
    }
  }

  const bindSessionEvents = (): void => {
    const snapshot = sessionsRuntime.list.getSnapshot() as SessionListSnapshot
    for (const sessionId of snapshot.ids) {
      if (subscribedSessions.has(sessionId))
        continue
      const session = sessionsRuntime.binding(sessionId)?.session
      if (!session?.subscribe)
        continue
      subscribedSessions.add(sessionId)
      // 会话事件流在流式输出期间每秒可通知上百次：复核必须经节流器合并，
      // 否则每个事件都会打一次 /status（宿主还会 fork 一个 git 子进程）。
      // 工作树会话的 checkout/discard 收敛由这条「自身事件」路径负责（列表路径不再复核）。
      controller.add(session.subscribe(() => requestEventReconcile(sessionId)))
    }
  }
  const unsubscribeSessions = sessionsRuntime.list.subscribe(() => {
    noteListBaseline()
    noteAppearances()
    hydrate()
    bindSessionEvents()
    // 用户切换到某个会话时给它一次重新校准的机会：曾因重试预算耗尽被放弃的会话在此
    // 重新进入复核（只在切换时重置，不会让当前会话变成永久轮询）。
    const current = (sessionsRuntime.list.getSnapshot() as SessionListSnapshot).current
    if (current && current !== lastCurrent) {
      lastCurrent = current
      exhausted.delete(current)
      retryAttempts.delete(current)
      retryWindowStart.set(current, Date.now())
      requestEventReconcile(current)
    }
  })
  const unsubscribeWorkspaces = workspacesRuntime.list.subscribe(cleanupArchivedWorktrees)
  controller.add(unsubscribeSessions)
  controller.add(unsubscribeWorkspaces)
  noteListBaseline()
  noteAppearances()
  // 初始 current 由本次 hydrate 直接覆盖，不算「切换」——否则首个列表快照会为当前会话
  // 多补一次复核（重复请求）。
  lastCurrent = (sessionsRuntime.list.getSnapshot() as SessionListSnapshot).current
  hydrate()
  bindSessionEvents()
  cleanupArchivedWorktrees()
  return () => controller.dispose()
}
