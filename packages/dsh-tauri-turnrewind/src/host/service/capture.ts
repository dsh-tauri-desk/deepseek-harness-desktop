/**
 * host/service/capture.ts — turn 生命周期编排：before 快照 → after 快照 → 差异 → 账本。
 *
 * 时机（两个内核都已核实）：
 *   - `agent/pre-step`（step === 1，waterfall，可 await）：**执行屏障**。本函数返回前，
 *     模型请求与任何工具都不会执行，因此 before 快照必然早于一切文件改动。
 *   - `session/event` 的 `turn/end`：after 快照与差异在**后台 FIFO**里结算，不阻塞
 *     turn 落定；`agent/status → idle` 兜底被中断的 turn。
 *
 * 并发语义：私有仓的 index/refs 是每个工作区共享的可变状态，所有 git 动作
 * （捕获、结算、实时读数、容量治理、撤销）都经**同一个** {@link WorkspaceQueue}
 * 串行——队列实例由 apply 创建并同时交给路由层，撤销因此与捕获互斥。
 *
 * 失败语义：任何捕获/统计失败都只写日志 + 账本里记 `unavailable`，绝不抛给 Agent 链路。
 */

import type { LiveSnapshot, SnapshotStore, TurnFileChange, TurnRecord } from '../types'
import type { WorkspaceQueue } from './queue'
import {
  LIVE_POLL_INTERVAL_MS,
  REASON_SNAPSHOT_FAILED,
  REASON_UNSAFE_WORKSPACE,
} from '../constants'
import { pruneLooseObjects } from './git'
import { recordTurn, recordWorkspaceState } from './ledger'
import { ensureWorkspaceRetention, readExclusions, writeExclusions } from './retention'
import {
  captureSnapshot,
  deleteRefs,
  diffTurnChanges,
  liveDiff,
  scanNestedRepos,
  snapshotStoreFor,
  turnRef,
} from './snapshot'
import { probeWorkspace } from './workspace'

/** 一个正在进行中的 turn 的捕获状态。 */
interface ActiveTurn {
  sessionId: string
  turn: number
  workspaceRoot: string | null
  store: SnapshotStore | null
  beforeCommit: string | null
  /** 本 turn 不可撤销的原因（资格拒绝/快照失败）。 */
  skippedReason: string | null
  /** 运行中实时读数（before 快照成功后开始轮询更新；`active` 由读取面补上）。 */
  live: Omit<LiveSnapshot, 'active'> | null
  liveTimer: ReturnType<typeof setInterval> | null
  /** 上一次实时刷新是否仍在飞（防止慢仓库堆积轮询）。 */
  liveBusy: boolean
  /**
   * 读数世代：每次作废（停表/重置）自增。在飞的 `git diff` 落地时世代已变即丢弃结果——
   * 否则一次晚到的刷新会把刚被重置掉的读数**复活**，提示条又带着旧统计回来。
   */
  liveEpoch: number
  /** 本 turn 应用的排除路径（超限文件 + 嵌套仓库），捕获与实时读数共用。 */
  exclusions: string[]
  /** 本 turn 实际被跳过的嵌套仓库。 */
  nestedDirs: string[]
  /** before 快照时的快照仓代数（写进账本，供撤销判定过期）。 */
  generation: string | null
}

/** 日志面（宿主 logger 的最小契约；缺失时静默）。 */
export interface CaptureLogger {
  warn?: (message: string) => void
  info?: (message: string) => void
}

export interface TurnCapture {
  /** pre-step 屏障：完成 before 快照（或明确标记不可撤销）。 */
  beginTurn: (sessionId: string, turn: number, cwd: unknown) => Promise<void>
  /** turn 结束后台结算：after 快照 + 差异 + 账本。 */
  settleTurn: (sessionId: string, turn: number) => Promise<void>
  /** 会话空闲兜底：结算该会话所有未落定的 turn。 */
  settleIdle: (sessionId: string) => Promise<void>
  /**
   * 立刻作废实时读数（停表 + 清读数），条目本身保留给后台结算。
   * 省略 `turn` 即整个会话（会话结束）；`turn/end` 与 idle 兜底按轮次调用。
   */
  resetLive: (sessionId: string, turn?: number) => void
  /**
   * 该轮是否仍未落定（before 快照在飞、或 after 快照尚未结算）。
   *
   * 撤销用它判定「仍在运行中」——**不能**用实时读数是否 active（读数是提示条的过程态，
   * `turn/end` 一到就归零，而这一轮此后还要在后台结算）。省略 `turn` 表示整个会话。
   */
  isTurnPending: (sessionId: string, turn?: number) => boolean
  /** 运行中实时读数（客户端「运行中」提示条轮询）。 */
  liveState: (sessionId: string) => LiveSnapshot
  /** 卸载：清定时器并丢弃内存态（在飞任务由调用方等待）。 */
  dispose: () => void
}

export interface TurnCaptureOptions {
  /** 宿主数据根目录。 */
  dshHome: string
  /** 工作区级串行队列（与路由层共用，撤销因此与捕获互斥）。 */
  queue: WorkspaceQueue
  logger?: CaptureLogger | undefined
  /** 账本写入成功后的回调（用于触发 hookable 钩子）。 */
  onCaptured?: ((sessionId: string, turn: number, fileCount: number) => void) | undefined
}

function activeKey(sessionId: string, turn: number): string {
  return `${sessionId}:${turn}`
}

/**
 * 创建 turn 捕获编排器。
 * @param options - 数据根目录、共享队列、日志与回调。
 * @returns 捕获编排器句柄。
 */
export function createTurnCapture(options: TurnCaptureOptions): TurnCapture {
  const { dshHome, queue } = options
  const logger = options.logger
  const onCaptured = options.onCaptured
  const active = new Map<string, ActiveTurn>()
  /**
   * 正在执行的 before 快照（key → 会话/turn + 落地 promise）。
   *
   * before 快照挂在 `agent/pre-step` 的**执行屏障**上，大仓库要跑几秒到几十秒（首次还要
   * 初始化私有仓）。用户在这个窗口里手动停止时，`turn/end` 与 `agent/status → idle`
   * 都可能在 `active` 里还没有条目的时候就到达——那一刻 `settleTurn` / `settleIdle`
   * 直接返回，这一轮就**再也不会被结算**，直到很久以后某个 idle 才被顺手收掉
   * （实测有 30 分钟后才落账的），卡片自然一直不出现。
   * 因此结算必须先等这份 promise 落地（见 {@link settleTurn} / {@link settleIdle}）。
   */
  const beginning = new Map<string, { sessionId: string, turn: number, task: Promise<void> }>()
  /**
   * 正在结算的 turn。`settleTurn` 现在要先 await before 快照，中间多了一个让出点，
   * 必须自己保证幂等：`turn/end` 与 `agent/status → idle` 常常几乎同时到达。
   */
  const settling = new Set<string>()
  let disposed = false

  const warn = (message: string): void => {
    logger?.warn?.(message)
  }

  function skippedEntry(sessionId: string, turn: number, parts: { store: SnapshotStore, workspaceRoot: string } | null, reason: string): ActiveTurn {
    return {
      sessionId,
      turn,
      workspaceRoot: parts?.workspaceRoot ?? null,
      store: parts?.store ?? null,
      beforeCommit: null,
      skippedReason: reason,
      live: null,
      liveTimer: null,
      liveBusy: false,
      liveEpoch: 0,
      exclusions: [],
      nestedDirs: [],
      generation: null,
    }
  }

  /**
   * `agent/pre-step` 屏障入口：登记在飞的 before 快照，并等它落地。
   * 真实工作见 {@link runBeginTurn}（拆出来是为了让结算侧能 await 同一份 promise）。
   */
  async function beginTurn(sessionId: string, turn: number, cwd: unknown): Promise<void> {
    if (disposed)
      return
    const key = activeKey(sessionId, turn)
    if (active.has(key) || beginning.has(key))
      return
    // 落地 promise 永不 reject：结算侧要 await 它，一次失败的快照不能把结算也带走。
    const task = runBeginTurn(sessionId, turn, cwd).then(
      () => undefined,
      async (error: unknown) => {
        warn(`dsh-tauri-turnrewind: before snapshot for session ${sessionId} turn ${turn} failed: ${String(error)}`)
        // 意外异常（git/IO 抛错，而不是 captureSnapshot 收敛过的结果对象）同样要留一笔账：
        // 与 skippedEntry 一致，客户端才知道「这一轮存在过」。没有基线 → 卡片保持沉默。
        await recordUnavailable(dshHome, sessionId, turn, REASON_SNAPSHOT_FAILED).catch(() => undefined)
      },
    )
    beginning.set(key, { sessionId, turn, task })
    try {
      await task
    }
    finally {
      if (beginning.get(key)?.task === task)
        beginning.delete(key)
    }
  }

  /**
   * before 快照的真实工作：探测工作区资格 → 容量治理 → 捕获 before → 登记活动条目并起实时轮询。
   * 拆成独立函数是为了让 {@link beginTurn} 能把它登记成「在飞 promise」供结算侧 await。
   * @param sessionId - 会话 id。
   * @param turn - turn 号。
   * @param cwd - 会话 cwd（用于解析 worktree 根）。
   */
  async function runBeginTurn(sessionId: string, turn: number, cwd: unknown): Promise<void> {
    const key = activeKey(sessionId, turn)
    // 快照跑完时插件可能已经卸载：不再登记条目，否则会留下永不清理的轮询定时器。
    const register = (entry: ActiveTurn): boolean => {
      if (disposed)
        return false
      active.set(key, entry)
      return true
    }
    const probe = await probeWorkspace(cwd)
    if (!probe.ok) {
      // 非 Git / 系统目录 / git 缺失：不建快照。资格结论写进账本供客户端呈现。
      // 「确实是 Git 仓库但被守卫拒绝」的目录保持 isGit=true，只带不可用原因，
      // 避免客户端误报「需要 Git 仓库」。
      await recordWorkspaceState(dshHome, sessionId, {
        workspaceRoot: null,
        isGit: probe.reason === REASON_UNSAFE_WORKSPACE,
        unavailableReason: probe.reason,
      }).catch(() => undefined)
      register(skippedEntry(sessionId, turn, null, probe.reason))
      return
    }
    const store = snapshotStoreFor(dshHome, probe.root, probe.commonDir)
    // 工作区首次触碰：容量治理（prune 不可达对象 / 超限整仓重建 / 排除清单复检）。
    const exclusions = await queue.run(probe.root, async () => {
      const retention = await ensureWorkspaceRetention(store)
      if (retention?.rebuilt)
        warn(`dsh-tauri-turnrewind: snapshot repository for ${probe.root} exceeded the size cap and was rebuilt; older turns are now expired`)
      return retention?.exclusions ?? await readExclusions(store)
    }).catch(() => [] as string[])

    const nestedDirs = scanNestedRepos(probe.root)
    const result = await queue.run(probe.root, () =>
      captureSnapshot(store, turnRef(sessionId, turn, 'before'), `turn ${turn} before`, { exclude: exclusions, nestedDirs }))
    if (!result.ok) {
      warn(`dsh-tauri-turnrewind: before snapshot for session ${sessionId} turn ${turn} unavailable: ${result.reason}`)
      await recordWorkspaceState(dshHome, sessionId, {
        workspaceRoot: probe.root,
        isGit: true,
        unavailableReason: null,
      }).catch(() => undefined)
      register(skippedEntry(sessionId, turn, { store, workspaceRoot: probe.root }, result.reason))
      return
    }
    await recordWorkspaceState(dshHome, sessionId, {
      workspaceRoot: probe.root,
      isGit: true,
      unavailableReason: null,
    }).catch(() => undefined)
    // 本轮新学到的排除项（超限文件/嵌套仓库）持久化：后续 turn 不必再付一次重捕代价。
    if (result.learnedExclusions.length > 0)
      await writeExclusions(store, [...exclusions, ...result.learnedExclusions])

    const entry: ActiveTurn = {
      sessionId,
      turn,
      workspaceRoot: probe.root,
      store,
      beforeCommit: result.commit,
      skippedReason: null,
      live: { turn, fileCount: 0, insertions: 0, deletions: 0 },
      liveTimer: null,
      liveBusy: false,
      liveEpoch: 0,
      exclusions: [...new Set([...exclusions, ...result.learnedExclusions])],
      nestedDirs: result.skippedNestedRepos,
      generation: store.generation ?? null,
    }
    // 新一轮登记前先收回旧轮的读数：提示条从这一轮从零开始，绝不带着上一轮的统计。
    retireOlderLive(sessionId, turn)
    if (register(entry))
      startLivePolling(entry)
  }

  /**
   * 运行中轮询：定时把「当前工作区 vs before 快照」的读数刷进 entry.live。
   * 上一次刷新还在飞就跳过本次（慢仓库/大仓库时不堆积 git 子进程）；
   * 定时器 unref，不阻止宿主进程退出。
   */
  function startLivePolling(entry: ActiveTurn): void {
    if (entry.liveTimer !== null || entry.store === null || entry.beforeCommit === null)
      return
    const timer = setInterval(() => {
      void refreshLive(entry)
    }, LIVE_POLL_INTERVAL_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    entry.liveTimer = timer
  }

  async function refreshLive(entry: ActiveTurn): Promise<void> {
    if (disposed || entry.liveBusy || entry.store === null || entry.beforeCommit === null)
      return
    const store = entry.store
    const beforeCommit = entry.beforeCommit
    const workspaceRoot = entry.workspaceRoot
    if (workspaceRoot === null)
      return
    // 记下本次刷新的世代：期间发生任何作废（turn/end、会话结束、新一轮开始），
    // 结果都必须丢弃，不能让提示条把已经重置掉的读数复活。
    const epoch = entry.liveEpoch
    entry.liveBusy = true
    try {
      // 嵌套仓库目录（`entry.nestedDirs`）必须一起传：超限文件在 `exclusions` 里，
      // 而目录语义的排除（`:(exclude,glob)dir/**`）只有独立传入才生效。漏掉时
      // `git add` 会把嵌套仓库当成 gitlink 写进私有 index，读数于是报出
      // 「2 个文件已更改 +2 -0」这种工作区根本没发生过的改动（见 liveDiff 的注释）。
      const result = await queue.run(workspaceRoot, () => liveDiff(store, beforeCommit, {
        exclude: entry.exclusions,
        nestedDirs: entry.nestedDirs,
      }))
      if (result.ok && entry.liveEpoch === epoch)
        entry.live = { turn: entry.turn, ...result.stats }
    }
    catch (error) {
      warn(`dsh-tauri-turnrewind: live diff failed: ${String(error)}`)
    }
    finally {
      entry.liveBusy = false
    }
  }

  function stopLivePolling(entry: ActiveTurn): void {
    if (entry.liveTimer !== null) {
      clearInterval(entry.liveTimer)
      entry.liveTimer = null
    }
    entry.live = null
    // 世代自增：在飞的刷新落地时会被认作过期结果丢弃（见 refreshLive）。
    entry.liveEpoch += 1
  }

  /**
   * 作废实时读数（可只针对某一轮）。
   *
   * 读数是**过程态**：它相对的是本轮的 before 快照，工作区此后每一次改动都会让它变大。
   * 一旦这一轮（或整个会话）结束，这份读数就再也不是「当前正在发生什么」，必须立刻归零——
   * 否则客户端提示条会一直展示上一轮的统计，并且随着工作区继续变化而单调变大
   * （用户实际反馈的「统计一直在叠加」）。
   *
   * 只清读数、不停条目：after 快照与账本仍然由结算路径照常完成。
   * @param sessionId - 会话 id。
   * @param turn - 省略即该会话全部轮次（会话结束/销毁）。
   */
  function resetLive(sessionId: string, turn?: number): void {
    for (const entry of active.values()) {
      if (entry.sessionId !== sessionId)
        continue
      if (turn !== undefined && entry.turn !== turn)
        continue
      stopLivePolling(entry)
    }
  }

  /**
   * 新一轮开始时收回更早轮次的读数。
   *
   * 只清 `turn` 更小的条目（严格单调），并发路径下不会误伤刚开始的这一轮；
   * 上一轮若还在后台结算，它的读数也不再上报——提示条永远只反映当前这一轮。
   */
  function retireOlderLive(sessionId: string, turn: number): void {
    for (const entry of active.values()) {
      if (entry.sessionId === sessionId && entry.turn < turn)
        stopLivePolling(entry)
    }
  }

  /**
   * 该轮是否仍未落定：before 快照还在飞（{@link beginning}）或 after 尚未结算（{@link active}）。
   * 结算失败时条目会留在 `active` 里等重试，因此它同样算「未落定」——撤销必须继续拒绝。
   * @param sessionId - 会话 id。
   * @param turn - turn 号；省略即该会话是否有任何未落定的轮次。
   */
  function isTurnPending(sessionId: string, turn?: number): boolean {
    for (const entry of active.values()) {
      if (entry.sessionId === sessionId && (turn === undefined || entry.turn === turn))
        return true
    }
    if (turn === undefined) {
      for (const item of beginning.values()) {
        if (item.sessionId === sessionId)
          return true
      }
      return false
    }
    return beginning.has(activeKey(sessionId, turn))
  }

  /**
   * 运行中实时读数；没有正在进行的 turn 时返回 active: false。
   *
   * 同一会话可能同时留着多条（旧轮还在后台结算，新一轮已经开始）：
   * 只认**轮次最新**的那条的读数——按插入序取第一条会报出更早 before 快照的差值，
   * 看上去就是跨轮累加的数字。
   */
  function liveState(sessionId: string): LiveSnapshot {
    let newest: ActiveTurn | null = null
    for (const entry of active.values()) {
      if (entry.sessionId !== sessionId || entry.live === null)
        continue
      if (newest === null || entry.turn > newest.turn)
        newest = entry
    }
    if (newest === null || newest.live === null)
      return { active: false, turn: null, fileCount: 0, insertions: 0, deletions: 0 }
    return { active: true, ...newest.live }
  }

  /**
   * 结算一轮：等 before 快照落地 → 捕 after → 差异 → 写账本。
   *
   * 幂等：`turn/end` 与 `agent/status → idle` 常常几乎同时到达，而本函数现在还要 await
   * 在飞的 before 快照（多了一个让出点），因此按 key 用 {@link settling} 串行。
   * 只有走到**终态**（无 store / 无基线 / 账本已写）才把条目移出 `active`：中途抛错
   * （git/IO 异常）时留着它，下一次 `turn/end` 或 idle 还能重试，而不是让这一轮永远没有记录。
   * @param sessionId - 会话 id。
   * @param turn - turn 号。
   */
  async function settleTurn(sessionId: string, turn: number): Promise<void> {
    const key = activeKey(sessionId, turn)
    if (settling.has(key))
      return
    if (!active.has(key) && !beginning.has(key))
      return
    settling.add(key)
    // 终态标记：只有它才能让条目离开 `active`（见 finally）。
    let terminal = false
    try {
      // 用户手动停止可能落在 before 快照还飞着的时候（屏障上要跑几秒到几十秒）：
      // 先等它落地，否则这一轮会被整个漏掉 —— 账本里没有行，turn 尾部的卡片也就
      // 永远不会出现（用户实际遇到的现象）。
      await beginning.get(key)?.task
      const entry = active.get(key)
      if (entry === undefined)
        return
      // 结算即结束运行中提示（`turn/end`/idle 已在事件边界调用过 resetLive，这里再兜一次：
      // 读数是过程态，不该跨 turn 残留）。
      stopLivePolling(entry)
      if (entry.workspaceRoot === null || entry.store === null) {
        terminal = true
        return
      }
      if (entry.beforeCommit === null) {
        // 连基线都没建立：这一轮从来没有过可撤销的承诺，账本行不带 ref（客户端据此沉默）。
        await recordUnavailable(dshHome, sessionId, entry.turn, entry.skippedReason ?? REASON_SNAPSHOT_FAILED)
        terminal = true
        return
      }
      const store = entry.store
      const workspaceRoot = entry.workspaceRoot
      const beforeCommit = entry.beforeCommit
      await queue.run(workspaceRoot, async () => {
        const after = await captureSnapshot(store, turnRef(sessionId, turn, 'after'), `turn ${turn} after`, {
          exclude: entry.exclusions,
          nestedDirs: entry.nestedDirs,
        })
        if (!after.ok) {
          // 基线在、after 失败：这是「承诺过的撤销落空了」，账本行保留 before ref，
          // 客户端据此仍然给出告警（与上面「从没建立基线」的沉默区分开）。
          await recordUnavailable(dshHome, sessionId, turn, after.reason, turnRef(sessionId, turn, 'before'))
          terminal = true
          return
        }
        const diff = await diffTurnChanges(store, beforeCommit, after.commit)
        if (!diff.ok) {
          await recordUnavailable(dshHome, sessionId, turn, REASON_SNAPSHOT_FAILED, turnRef(sessionId, turn, 'before'))
          terminal = true
          return
        }
        const record = buildRecord(turn, sessionId, diff.changes, {
          generation: entry.generation,
          skippedOversized: after.skippedOversized,
          skippedNestedRepos: after.skippedNestedRepos,
        })
        const mutation = await recordTurn(dshHome, sessionId, record)
        // 账本已经落定 → 立即进入终态：后面几步（删 refs / prune / 回调）即使抛错也不能重试，
        // 否则会重复捕 after、重复触发 onCaptured，还可能把之后才发生的改动算进这一轮。
        terminal = true
        // 保留窗口淘汰 / 硬上限丢弃：删掉对应 refs，再回收不可达对象（含实时读数留下的
        // 中间版本 blob）。prune 只在真的淘汰了东西时跑，避免每个 turn 都走一遍对象库。
        if (mutation.refsToDelete.length > 0) {
          await deleteRefs(store, mutation.refsToDelete)
          await pruneLooseObjects(store)
        }
        onCaptured?.(sessionId, turn, record.files.length)
      })
    }
    finally {
      settling.delete(key)
      if (terminal)
        active.delete(key)
    }
  }

  /**
   * 会话空闲兜底：结算「idle 那一刻已经存在」的 turn。
   * @param sessionId - 会话 id。
   */
  async function settleIdle(sessionId: string): Promise<void> {
    // 候选集必须**同步取定**（idle 处理函数在 emit 里同步进入本函数）：这次兜底只该结算
    // 「idle 那一刻已经存在」的 turn。若等完在飞的快照再去看 active，就可能把 idle 之后
    // 新开始、其实还在跑的 turn 误结算掉（它的 after 会在 before 刚结束时被拍下来，
    // 那一轮的卡片就再也收不到真实改动了）。
    const inflight = [...beginning.values()].filter(item => item.sessionId === sessionId)
    const candidates = [...active.values()].filter(entry => entry.sessionId === sessionId)
    // idle 同样可能早于该会话的 before 快照落地（手动中断最常见的时序）：先等它们。
    if (inflight.length > 0)
      await Promise.all(inflight.map(item => item.task))
    for (const entry of candidates)
      await settleTurn(sessionId, entry.turn)
    // 在飞的那些当时还没有 active 条目，落地后按 turn 号结算（settleTurn 内部幂等）。
    for (const item of inflight)
      await settleTurn(sessionId, item.turn)
  }

  return {
    beginTurn,
    settleTurn,
    settleIdle,
    resetLive,
    isTurnPending,
    liveState,
    dispose(): void {
      disposed = true
      // 卸载必须清掉每个 active turn 的轮询定时器，否则插件停用后仍会持续拉起 git 子进程。
      for (const entry of active.values())
        stopLivePolling(entry)
      active.clear()
    },
  }
}

function buildRecord(
  turn: number,
  sessionId: string,
  files: TurnFileChange[],
  extras: { generation: string | null, skippedOversized: string[], skippedNestedRepos: string[] },
): TurnRecord {
  let insertions = 0
  let deletions = 0
  for (const file of files) {
    insertions += file.insertions ?? 0
    deletions += file.deletions ?? 0
  }
  return {
    turn,
    // 账本只留 ref：commit oid 由 ref 解析（撤销前会重新 rev-parse 校验），
    // 避免账本与仓库状态出现两份可能漂移的真相。
    beforeRef: turnRef(sessionId, turn, 'before'),
    afterRef: turnRef(sessionId, turn, 'after'),
    files,
    insertions,
    deletions,
    createdAt: Date.now(),
    undoneAt: null,
    unavailable: null,
    generation: extras.generation,
    skippedOversized: extras.skippedOversized,
    skippedNestedRepos: extras.skippedNestedRepos,
  }
}

/**
 * 记录一个不可撤销的 turn（快照失败/超限），保留原因供卡片呈现。
 *
 * `beforeRef` 只在**基线确实建立过**时传入：客户端用它把两种结局分开——
 * 「这一轮从没建立过快照」不弹告警（本来就没有可撤销的东西），
 * 「基线在、after 结算失败」必须如实告警（承诺过的撤销落空了）。
 * 同时它也让保留窗口淘汰时能把这根孤儿 ref 一起回收。
 */
async function recordUnavailable(dshHome: string, sessionId: string, turn: number, reason: string, beforeRef = ''): Promise<void> {
  await recordTurn(dshHome, sessionId, {
    turn,
    beforeRef,
    afterRef: '',
    files: [],
    insertions: 0,
    deletions: 0,
    createdAt: Date.now(),
    undoneAt: null,
    unavailable: reason,
  })
}
