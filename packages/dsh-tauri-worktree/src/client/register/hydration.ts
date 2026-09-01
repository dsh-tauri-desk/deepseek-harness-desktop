/**
 * hydration.ts — 从 Host ledger 恢复所有已知会话的工作树状态。
 *
 * Mode selector 只在 hero composer 出现，不能承担全局状态恢复；侧边栏图标、归组、
 * 状态条和弹窗均依赖本 observer 在普通历史会话打开前完成 hydration。
 *
 * 启动/新建会话存在竞态（客户端列表先于宿主会话就绪）：/status 失败或返回未知
 * （isGit: null）时按固定间隔重试，直到拿到确定答案，保证「刷新才有」的工作树 UI 自愈。
 *
 * create_worktree 自动交接只允许发生在「本次运行期间新出现」的工作树会话首次复核时，
 * 且每个来源只交接一次、有时效窗口——历史遗留工作树、用户事后回到源会话、点击新建
 * 会话等场景绝不抢焦点（否则「新建会话」会被误跳到工作树会话）。
 */
import type { ClientContext } from 'dsh-tauri/client'
import type { SessionListSnapshot, WorkspaceListSnapshot, WorktreeHydrationSessionsRuntime } from '../types'
import { createLifecycleController } from 'dsh-tauri/client'
import { HANDOFF_WINDOW_MS, HYDRATION_MAX_RETRIES, HYDRATION_RETRY_DELAY_MS } from '../constants'
import { openWorktreeSession } from '../service/handoff'
import { attachWorktreeSession, discardWorktree, fetchStatus, patchSession, selectSessionState, worktreeStore } from '../store'

export function installWorktreeHydration(ctx: ClientContext): () => void {
  // HARDCODE: SessionRuntime.binding() is an internal DSH 0.1.1-rc.2 API.
  // The public session-list source does not emit every tool-event mutation, so
  // live checkout/discard reconciliation subscribes to the bound Session source.
  const sessionsRuntime = ctx.sessions as unknown as WorktreeHydrationSessionsRuntime
  const controller = createLifecycleController()
  const seen = new Set<string>()
  const switching = new Map<string, string>()
  const cleanedArchives = new Set<string>()
  const inFlight = new Set<string>()
  const queued = new Set<string>()
  const retryAttempts = new Map<string, number>()
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
  controller.add(() => retryAttempts.clear())

  /**
   * 捕获插件安装基线：等第一个非空列表快照（应用启动时列表 RPC 可能尚未返回，
   * 空快照不能当基线，否则启动期已存在的工作树会话会被误判为「新出现」）。
   */
  const noteListBaseline = (): void => {
    if (baselineCaptured)
      return
    const snapshot = ctx.sessions.list.getSnapshot() as SessionListSnapshot
    if (snapshot.ids.length === 0)
      return
    baselineCaptured = true
    for (const sessionId of snapshot.ids)
      baselineIds.add(sessionId)
  }

  /** 记录会话首次出现在列表的时间（交接时效窗口的起点）。 */
  const noteAppearances = (): void => {
    const snapshot = ctx.sessions.list.getSnapshot() as SessionListSnapshot
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
   * 达到上限后停止定时重试，但失败/未知都会从 seen 移除，后续列表事件仍可再次拉起。
   */
  function scheduleRetry(sessionId: string): void {
    if (controller.isDisposed())
      return
    const attempts = retryAttempts.get(sessionId) ?? 0
    if (attempts >= HYDRATION_MAX_RETRIES) {
      retryAttempts.delete(sessionId)
      return
    }
    retryAttempts.set(sessionId, attempts + 1)
    controller.timeout(() => {
      if (controller.isDisposed())
        return
      reconcileSession(sessionId, true)
    }, HYDRATION_RETRY_DELAY_MS)
  }

  function reconcileSession(sessionId: string, force = false): void {
    if (inFlight.has(sessionId)) {
      if (force)
        queued.add(sessionId)
      return
    }
    const previous = selectSessionState(worktreeStore.getSnapshot(), sessionId)
    // 普通 hydration 每个会话只做一次；已绑定会话则在其事件流变化时强制复核，
    // 以便 Agent 调用 checkout_worktree / discard_worktree 后无刷新切回本地状态。
    if (!force && seen.has(sessionId))
      return
    seen.add(sessionId)
    inFlight.add(sessionId)
    void fetchStatus(sessionId)
      .then((status) => {
        if (controller.isDisposed())
          return
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
        // 默认 git 假设与用户已选模式（选择器可见），固定间隔重试直到拿到确定答案。
        if (status.isGit === null) {
          seen.delete(sessionId)
          scheduleRetry(sessionId)
          return
        }
        retryAttempts.delete(sessionId)
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
        // 从 seen 移除并退避重试，使启动/新建竞态在无刷新下自愈。
        seen.delete(sessionId)
        scheduleRetry(sessionId)
      })
      .finally(() => {
        inFlight.delete(sessionId)
        if (queued.delete(sessionId) && !controller.isDisposed())
          reconcileSession(sessionId, true)
      })
  }

  const hydrate = (): void => {
    const snapshot = ctx.sessions.list.getSnapshot() as SessionListSnapshot
    for (const sessionId of snapshot.ids) reconcileSession(sessionId)
  }

  // 原生侧栏「归档」只隐藏会话。若该会话绑定工作树，归档集合变化后补做
  // worktree/owned branch/ledger 清理；会话日志仍由 DSH 归档持久化保留。
  const cleanupArchivedWorktrees = (): void => {
    const snapshot = ctx.workspaces.list.getSnapshot() as WorkspaceListSnapshot
    for (const sessionId of snapshot.archivedSessionIds) {
      if (cleanedArchives.has(sessionId))
        continue
      cleanedArchives.add(sessionId)
      void fetchStatus(sessionId)
        .then((status) => {
          if (controller.isDisposed() || status.mode !== 'worktree')
            return
          return discardWorktree(sessionId, status.worktreeKey ?? '')
        })
        .catch(() => {
          // 网络/Host 暂不可用时允许下次快照重试。
          cleanedArchives.delete(sessionId)
        })
    }
  }

  const bindSessionEvents = (): void => {
    const snapshot = ctx.sessions.list.getSnapshot() as SessionListSnapshot
    for (const sessionId of snapshot.ids) {
      if (subscribedSessions.has(sessionId))
        continue
      const session = sessionsRuntime.binding(sessionId)?.session
      if (!session?.subscribe)
        continue
      subscribedSessions.add(sessionId)
      controller.add(session.subscribe(() => {
        const state = selectSessionState(worktreeStore.getSnapshot(), sessionId)
        if (state.mode === 'worktree')
          reconcileSession(sessionId, true)
      }))
    }
  }
  const unsubscribeSessions = ctx.sessions.list.subscribe(() => {
    noteListBaseline()
    noteAppearances()
    hydrate()
    bindSessionEvents()
  })
  const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(cleanupArchivedWorktrees)
  controller.add(unsubscribeSessions)
  controller.add(unsubscribeWorkspaces)
  noteListBaseline()
  noteAppearances()
  hydrate()
  bindSessionEvents()
  cleanupArchivedWorktrees()
  return () => controller.dispose()
}
