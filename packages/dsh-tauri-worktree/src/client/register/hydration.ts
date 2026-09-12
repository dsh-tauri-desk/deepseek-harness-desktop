/**
 * hydration.ts — 从 Host ledger 恢复所有已知会话的工作树状态。
 *
 * Mode selector 只在 hero composer 出现，不能承担全局状态恢复；侧边栏图标、归组、
 * 状态条和弹窗均依赖本 observer 在普通历史会话打开前完成 hydration。
 *
 * 请求模型（三级，目标是「请求量与会话数、事件数都解耦」）：
 *   1. **批量发现**：列表快照/启动时一次 `GET /bindings`（经节流器 + 在途去重）拿到全部
 *      工作树绑定与未收敛删除任务。绝不为列表里每个会话各打一次 /status——那是首次加载
 *      几百次请求的来源。
 *   2. **当前会话校准**：模式选择器只在当前会话渲染，只有它需要确定 isGit，因此切换会话
 *      时为它打一次 /status（每个会话最多一次，结果缓存在 store）。
 *   3. **回合结束复核**：工作树会话在 `running: true → false` 边沿复核一次，用于收敛
 *      Agent 的 checkout/discard（一个回合一次，而不是逐事件一次）。
 * 另有两条自发起路径：discard 任务轮询收敛、以及「宿主未知（isGit: null）」的有界重试
 * （窗口 + 全局配额 + 次数上限，见 scheduleRetry）。所有路径最终都经同一个节流器。
 *
 * create_worktree 自动交接只允许发生在「本次运行期间新出现」的工作树会话首次被发现时，
 * 且每个来源只交接一次、有时效窗口——历史遗留工作树、用户事后回到源会话、点击新建
 * 会话等场景绝不抢焦点（否则「新建会话」会被误跳到工作树会话）。
 */
import type { ClientContext } from 'dsh-tauri/client'
import type { SessionListSnapshot, WorkspaceListSnapshot, WorktreeHydrationSessionsRuntime } from '../types'
import { createLifecycleController } from 'dsh-tauri/client'
import { DISCARD_MAX_POLLS, DISCARD_POLL_DELAY_MS, HANDOFF_WINDOW_MS, HYDRATION_MAX_RETRIES, HYDRATION_RETRY_BUDGET_PER_SECOND, HYDRATION_RETRY_DELAY_MS, HYDRATION_RETRY_WINDOW_MS, SESSION_RECONCILE_MIN_INTERVAL_MS } from '../constants'
import { attachWorktreeSession, discardWorktree, fetchBindings, fetchStatus } from '../service/actions'
import { openWorktreeSession } from '../service/handoff'
import { patchSession, selectSessionState, worktreeStore } from '../store'
import { createKeyedThrottle } from '../utils/throttle'

/** 批量绑定同步在节流器里占用的保留 key（会话 id 不会是这种形状）。 */
const BINDINGS_THROTTLE_KEY = '@bindings'

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
  const switching = new Map<string, string>()
  const cleanedArchives = new Set<string>()
  const inFlight = new Set<string>()
  const queued = new Set<string>()
  const retryAttempts = new Map<string, number>()
  // 重试预算耗尽（宿主始终解析不出该会话）：永久退出列表驱动的复核，避免会话数放大请求量。
  const exhausted = new Set<string>()
  // 已拿到确定 isGit 的会话（`/status` 或批量绑定给出）。只有「当前会话」需要 isGit
  // （模式选择器据此渲染），因此逐会话 /status 只服务于「当前会话尚未校准」这一个场景。
  const gitResolved = new Set<string>()
  // 上次观察到的 running 回合位：只在 true → false 边沿复核（一个回合一次）。
  const lastRunning = new Map<string, boolean>()
  // 批量绑定请求在途标记（避免同一时刻叠加多个 /bindings）。
  let bindingsInFlight = false
  // 已知的会话 id 集合：列表集合变化才重新同步绑定。
  let knownIds = new Set<string>()
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
          // 删除任务刚结束：复核仍经节流器（保证「每次 /status 都在节流窗口内」这一不变量）。
          requestSessionReconcile(sessionId)
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
   *
   * 关键：重试链必须**可终止**。配额不足时的顺延同样消耗一次重试次数（见下），因此
   * 即使配额被长期抢光，链也会先撞上次数上限；窗口是第二道终止条件。绝不允许
   * 「配额不足 → 无条件再排一个 timeout」这种自我续命写法。
   */
  function scheduleRetry(sessionId: string): void {
    if (controller.isDisposed())
      return
    if (!retryWindowStart.has(sessionId))
      retryWindowStart.set(sessionId, Date.now())
    const attempts = retryAttempts.get(sessionId) ?? 0
    if (!withinRetryWindow(sessionId) || attempts >= HYDRATION_MAX_RETRIES) {
      retryAttempts.delete(sessionId)
      exhausted.add(sessionId)
      return
    }
    // 顺延也计入次数：配额由所有未解析会话共享，聚合速率因此有上界，且链一定终止。
    retryAttempts.set(sessionId, attempts + 1)
    if (!takeRetrySlot()) {
      controller.timeout(() => scheduleRetry(sessionId), HYDRATION_RETRY_DELAY_MS)
      return
    }
    controller.timeout(() => {
      if (controller.isDisposed())
        return
      requestGitCalibration(sessionId)
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
   * 批量绑定同步（列表快照 / 启动时触发）：**一次** `GET /bindings` 拿到全部工作树绑定与
   * 未收敛的删除任务，替代「列表里每个会话各打一次 /status」。
   *
   * 这是初次加载请求量的关键：老实现首轮 hydrate 会为列表里每个会话各发一次 /status
   * （实测某 profile 有 400 个会话 → 首次加载 400 次请求）；批量接口把它压到 1 次。
   * 请求本身经节流器（保留 key）+ 在途去重：列表快照高频变化时也只在窗口边界合并执行一次。
   */
  function requestBindingsSync(): void {
    reconcileThrottle.request(BINDINGS_THROTTLE_KEY, () => {
      if (bindingsInFlight || controller.isDisposed())
        return
      bindingsInFlight = true
      void fetchBindings()
        .then(applyBindings)
        .catch(() => {
          // 宿主路由尚未就绪/瞬时不可用：不写状态，等待下一次列表快照或当前会话校准。
        })
        .finally(() => {
          bindingsInFlight = false
        })
    })
  }

  /** 把批量绑定视图落到各会话状态：绑定 → worktree；删除任务 → deleting/error；其余按本地处理。 */
  function applyBindings(snapshot: import('../types').WorktreeBindings): void {
    if (controller.isDisposed())
      return
    const bound = new Map(snapshot.bindings.map(binding => [binding.sessionId, binding]))
    const jobs = new Map(snapshot.jobs.map(job => [job.sessionId, job]))

    for (const sessionId of sessionsRuntime.list.getSnapshot().ids) {
      const binding = bound.get(sessionId)
      if (binding) {
        patchSession(sessionId, {
          mode: 'worktree',
          phase: 'created',
          // 工作树由 git worktree add 创建，必然在 Git 仓库内：无需再为该会话打 /status。
          isGit: true,
          worktreeKey: binding.worktreeKey,
          worktreePath: binding.worktreePath,
          projectPath: binding.projectPath,
          sourceSessionId: binding.sourceSessionId,
          log: binding.log,
          error: '',
        })
        gitResolved.add(sessionId)
        retryAttempts.delete(sessionId)
        retryWindowStart.delete(sessionId)
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
        if (job.state === 'deleting')
          scheduleDiscardPoll(sessionId, job.jobId, 0)
        continue
      }

      // 既无绑定也无删除任务：宿主侧就是本地会话。若本地状态还停在 worktree（Agent 已完成
      // checkout/discard 而本端未收敛），这里一次性纠正，避免为了发现它而轮询。
      if (selectSessionState(worktreeStore.getSnapshot(), sessionId).mode === 'worktree')
        resetWorktreeSessionToLocal(sessionId)
    }

    // 批量结果到达后立刻校准当前会话的 isGit（它不在绑定里 = 本地会话）：
    // 这样启动只需「1 次 /bindings + 至多 1 次 /status」，而不是每个会话一次。
    const current = sessionsRuntime.list.getSnapshot().current
    if (current)
      requestGitCalibration(current)
  }

  /** 工作树模式 → 本地模式的状态复位（检出/放弃完成后同一份字段，避免两处漂移）。 */
  function resetWorktreeSessionToLocal(sessionId: string, projectPath?: string): void {
    patchSession(sessionId, {
      mode: 'local',
      phase: 'idle',
      isGit: true,
      loadingLabel: '',
      log: [],
      worktreeKey: '',
      worktreePath: '',
      ...(projectPath === undefined ? {} : { projectPath }),
      sourceSessionId: '',
      checkoutOpen: false,
      abandonOpen: false,
      error: '',
    })
  }

  /**
   * 当前会话的 isGit 校准：模式选择器只在当前会话渲染，因此只有它需要确定 isGit。
   * 已由批量绑定确定（工作树会话）或已校准过的会话不再请求。
   */
  function requestGitCalibration(sessionId: string): void {
    if (gitResolved.has(sessionId) || exhausted.has(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (!gitResolved.has(sessionId) && !exhausted.has(sessionId))
        reconcileSession(sessionId)
    })
  }

  /**
   * 无条件的节流复核入口（discard 任务收敛等自己发起的场景用）。
   * 与 requestGitCalibration 的区别：不受 gitResolved 影响——工作树会话的 gitResolved
   * 已经为 true，但删除完成后仍需要一次 /status 才能收敛回本地状态。
   */
  function requestSessionReconcile(sessionId: string): void {
    if (exhausted.has(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (!exhausted.has(sessionId) && !controller.isDisposed())
        reconcileSession(sessionId)
    })
  }

  /**
   * 会话事件流驱动的复核 —— 只在**回合结束**边沿触发一次（`running: true → false`）。
   *
   * 为什么不再逐事件复核：流式输出期间事件每秒上百次，而工作树状态只可能被
   * `create_worktree` / `checkout_worktree` / `discard_worktree` 改变，这些都发生在回合内。
   * 回合结束时补一次 `/status` 即可收敛，一个回合一次请求（见 lastRunning 边沿判定）。
   * 拿不到 running 位（核心版本差异）时退回事件驱动 + 节流，保证功能不退化。
   */
  function requestTurnEndReconcile(sessionId: string): void {
    if (exhausted.has(sessionId))
      return
    const worktreeMode = selectSessionState(worktreeStore.getSnapshot(), sessionId).mode === 'worktree'
    // 本地会话的回合结束无需复核：Agent 的 create_worktree 会产生**新会话**（由批量绑定发现）。
    if (!worktreeMode)
      return
    reconcileThrottle.request(sessionId, () => {
      if (selectSessionState(worktreeStore.getSnapshot(), sessionId).mode === 'worktree')
        reconcileSession(sessionId)
    })
  }

  /**
   * create_worktree 工具在 Host 先发布继承上下文的新根会话；它进入列表后，客户端把当前
   * 源会话视觉交接到该工作树会话（不启动额外模型 turn）。
   *
   * 触发必须同时满足：首次发现该会话已绑定工作树、会话是本次运行期间新出现（基线外且未过
   * 时效窗口）、当前仍在源会话、且该来源尚未交接过——否则会在「查看源会话」或「新建会话」
   * 流程中误抢焦点（跳到工作树会话，导致无法新建会话）。
   *
   * 由 /status 与批量 /bindings 两条发现路径共用（两者都可能在会话首次出现时先到达）。
   */
  function maybeHandoffToWorktree(sessionId: string, sourceSessionId: string): void {
    if (!sourceSessionId || worktreeReconciled.has(sessionId))
      return
    worktreeReconciled.add(sessionId)
    const currentId = sessionsRuntime.list.getSnapshot().current
    const appeared = appearedAt.get(sessionId)
    const fresh = !baselineIds.has(sessionId)
      && appeared !== undefined
      && Date.now() - appeared <= HANDOFF_WINDOW_MS
    if (!fresh || currentId !== sourceSessionId)
      return
    if (handedOff.has(sourceSessionId) || switching.has(sourceSessionId))
      return
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

  function reconcileSession(sessionId: string): void {
    if (inFlight.has(sessionId)) {
      queued.add(sessionId)
      return
    }
    const previous = selectSessionState(worktreeStore.getSnapshot(), sessionId)
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
          gitResolved.add(sessionId)
          retryAttempts.delete(sessionId)
          retryWindowStart.delete(sessionId)
          // 自愈旧 ledger 会话：Desktop workspace 补丁允许显式归属到源 Workspace。
          // 只对「正在复核的这个会话」执行——逐会话补 attach 会在启动时放大成几十上百次 POST。
          if (status.sourceSessionId)
            void attachWorktreeSession(sessionId).catch(() => {})
          maybeHandoffToWorktree(sessionId, status.sourceSessionId ?? '')
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
        gitResolved.add(sessionId)
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
          resetWorktreeSessionToLocal(sessionId, status.projectPath ?? previous.projectPath)
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
        // 请求在途期间又到达复核请求：**仍然经节流器**再补一次。
        // 绝不能在这里直接递归 reconcileSession：那会绕过节流窗口，变成「上一次刚结束、
        // 下一次立刻发」的串行无缝拉取。经节流器后，窗口内会被合并成一次拖尾执行。
        // 用无条件的 requestSessionReconcile（而非 requestGitCalibration）：在途的这次
        // 复核可能已经改变了工作树状态，补跑不能被 gitResolved 挡掉。
        if (queued.delete(sessionId) && !controller.isDisposed())
          requestSessionReconcile(sessionId)
      })
  }

  // 列表快照驱动：只在**会话集合真的变化**（新增/移除会话）时才重新批量同步绑定。
  // 会话列表在流式输出期间持续变化（running/标题等），但绑定只可能随「新建工作树会话 /
  // 检出 / 放弃」改变；用集合签名挡掉纯状态变化，避免把 /bindings 变成 1 次/秒的轮询。
  const hydrate = (): void => {
    const ids = sessionsRuntime.list.getSnapshot().ids
    let changed = ids.length !== knownIds.size
    if (!changed) {
      for (const sessionId of ids) {
        if (!knownIds.has(sessionId)) {
          changed = true
          break
        }
      }
    }
    if (!changed)
      return
    knownIds = new Set(ids)
    requestBindingsSync()
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
      // 会话事件流在流式输出期间每秒可通知上百次。这里**不**逐事件复核：只在
      // 「回合结束」边沿（running true → false）复核一次工作树状态——工作树只可能被
      // create/checkout/discard 工具改变，而它们都在回合内发生，回合结束补一次即可收敛。
      // 拿不到 running 位（核心版本差异）时退回事件驱动 + 节流，功能不退化。
      controller.add(session.subscribe(() => {
        if (controller.isDisposed())
          return
        const running = session.getSnapshot?.()?.running
        if (typeof running !== 'boolean') {
          requestTurnEndReconcile(sessionId)
          return
        }
        const previousRunning = lastRunning.get(sessionId)
        lastRunning.set(sessionId, running)
        // 首次观察只记录基线；只有 true → false 这一个边沿触发复核。
        if (previousRunning !== true || running)
          return
        requestTurnEndReconcile(sessionId)
      }))
    }
  }
  const unsubscribeSessions = sessionsRuntime.list.subscribe(() => {
    noteListBaseline()
    noteAppearances()
    hydrate()
    bindSessionEvents()
    // 当前会话切换：模式选择器只在当前会话渲染，只有它需要确定 isGit，因此只为它
    // 打一次 /status（其余会话的「是否工作树」由批量 /bindings 回答，不需要逐会话请求）。
    // 同时给曾因重试预算耗尽被放弃的会话一次重新校准的机会（只在切换时重置）。
    const current = (sessionsRuntime.list.getSnapshot() as SessionListSnapshot).current
    if (current && current !== lastCurrent) {
      lastCurrent = current
      exhausted.delete(current)
      retryAttempts.delete(current)
      retryWindowStart.set(current, Date.now())
      requestGitCalibration(current)
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
