/**
 * host/service/edit-session.ts — 编辑事务（宿主半区）。
 *
 * 一次 POST 完成三件事（单一执行路径，客户端只负责导航与发送）：
 *   1. 解析边界：目标轮之前**最后一个闭合回合**的 `turn/end`，据此得到 seed 的前缀长度；
 *   2. 用内核原语 `agents.create({ seed })` 建好截断后的子会话，并显式挂到源会话的工作区；
 *   3. 把 seed 继承来的**悬挂 inbox 入队项**排空（详见 `createChildSession`）：提问在内核里是
 *      「先 `agent/inbox/spliced` 入队 → `turn/start` → 之后才排空」，切在 `turn/start` 时
 *      排空事件落在 seed 之外，子会话重建 inbox 会让被丢弃的旧提问复活成一整轮。
 *
 * 为什么不由客户端建：官方 `sessions.fork({ atSeq })` 共用同一个切点，因此同样带这个缺陷
 * （DSH-EasyRewrite 在 0.1.5-rc.2 上实测复现）；只有宿主能同时做「切前缀 + 排空」。
 *
 * 上游来源：dsh-plugin-message-edit 的 `message-tree` 协议（MIT © SpookySandwich）
 * 与 dsh-easyrewrite 的边界判定（MIT © Renzic-Stone）。
 */

import type {
  HostContext,
  SessionEventLike,
  SessionRecordLike,
  TurnLike,
} from '../types'
import { logEvent } from './debug-log'
import { loadSessionRecord, sessionRecord } from './session-record'

/* ------------------------------------------------------------ 日志读取 -- */

/** 折叠完整回合括号；开放尾巴故意不参与。 */
export function closedTurns(events: readonly SessionEventLike[]): TurnLike[] {
  const result: TurnLike[] = []
  let current: Omit<TurnLike, 'endSeq'> | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn as number, startSeq: event.seq }
      continue
    }
    if (current === undefined)
      continue
    if (event.type === 'user/message' && current.user === undefined && (event.data.source as { kind?: string } | undefined)?.kind === 'user') {
      current.user = event
      continue
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      result.push({ ...current, endSeq: event.seq })
      current = undefined
    }
  }
  return result
}

/** 用户消息的文本块拼接。 */
export function userText(message: Record<string, unknown>): string {
  const content = message.content as Array<{ type?: string, text?: string }> | undefined
  if (!Array.isArray(content))
    return ''
  return content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/* ------------------------------------------------------------ 边界解析 -- */

/** 边界解析结果（与 DSH-EasyRewrite 的 /bubble/recall 语义一致）。 */
export type BoundaryResult
  = | { ok: true, boundary: number, turn: number, eventSeq: number, before: string, reset: boolean, prefixLength: number, pendingInbox: number }
    | { ok: false, code: 'session-not-found' | 'invalid-target' | 'turn-open' | 'no-boundary', message: string }

/**
 * 目标消息之前最后一个闭合回合的 `turn/end` seq。
 *
 * 官方 `sessions.fork({ atSeq })` 的切点是「第一个 >= atSeq 的 turn/end，再推进到下一轮
 * turn/start」，所以要把切点停在目标轮之前，锚点必须落在**上一轮的 turn/end** 上：
 * 命中它之后切点推进到本轮起点，本轮原样的提问与回答整段被丢弃，历史完整保留。
 * `turn.startSeq - 1` 正好等价于「上一轮的 turn/end」。
 *
 * 首轮之前只有系统提示、没有任何 turn/end 可锚 → `no-boundary`，由客户端走「新建会话」。
 */
export function resolveBoundary(record: SessionRecordLike, turnNumber: number, eventSeq: number | undefined): BoundaryResult {
  const turns = closedTurns(record.events)
  const turn = turns.find(candidate => candidate.turn === turnNumber)
  void logEvent('boundary', 'resolve', {
    sessionId: record.id,
    turn: turnNumber,
    eventSeq: eventSeq ?? null,
    eventsLength: record.events.length,
    turns: turns.map(candidate => ({ turn: candidate.turn, startSeq: candidate.startSeq, endSeq: candidate.endSeq, userSeq: candidate.user?.seq ?? null })),
  })
  if (turn === undefined) {
    // 目标轮还没有闭合（还在生成）或轮次号对不上。
    const openTurn = record.events.some(event => event.type === 'turn/start' && event.data.turn === turnNumber)
    if (openTurn)
      return { ok: false, code: 'turn-open', message: '该消息所在回合尚未结束，请等回复完成后再编辑。' }
    return { ok: false, code: 'invalid-target', message: `会话中找不到第 ${turnNumber} 轮。` }
  }
  if (turn.user === undefined)
    return { ok: false, code: 'invalid-target', message: '该回合没有用户消息，无法编辑。' }
  if (eventSeq !== undefined && turn.user.seq !== eventSeq)
    return { ok: false, code: 'invalid-target', message: '目标事件不是该回合的用户消息。' }

  // 锚点必须是「目标轮之前最后一个闭合回合的 turn/end seq」（DSH-EasyRewrite 的
  // findTurnEndBefore 同一判据）。
  //
  // 不能用 `turn.startSeq - 1`：`turn/start` 的前一个事件通常是 `agent/inbox/spliced`，
  // 而官方 fork 的切点是「第一个 seq >= atSeq 的 turn/end，再推进到下一轮 turn/start」。
  // 锚到 spliced 时 `find` 会命中**目标轮自己的 turn/end**，于是整段历史被保留、
  // 新消息只是追加在后面（实测到的「没回退、只在最后加一条」）。
  const previous = turns.find(candidate => candidate.turn === turn.turn - 1)
  const boundary = previous === undefined ? -1 : previous.endSeq
  if (boundary < 0) {
    // 首轮之前只有系统提示、没有任何 turn/end 可锚：fork 的最小切点是「一轮的末尾」，
    // 用它必然把整轮复制过去（就是「旧提问又跑一遍」）。上游 DSH-EasyRewrite 对这种情况
    // 走 reset：归档原会话 + 在同一工作区开一个全新会话，只把改后的提问发出去。
    void logEvent('boundary', 'ok-reset(first turn)', { sessionId: record.id, turn: turn.turn })
    return { ok: true, boundary: -1, turn: turn.turn, eventSeq: turn.user.seq, before: userText(turn.user.data), reset: true, prefixLength: 0, pendingInbox: countPendingInbox(preambleOf(record.events)) }
  }
  // 切点 = 目标轮的 `turn/start`（官方 cut 的等价物），但也**必须**知道 seed 里留下了几条
  // 悬挂的 inbox 入队项，交给 createChildSession 在**建完之后**用一条 live append 排空。
  //
  // 实测（源 4abe75f9 / 子 ade7c58a 的逐事件对比）：
  //   [19] turn/end(turn 1)
  //   [21] inbox inserted=1 start=1      ← 目标轮 2 的提问已入队
  //   [22] turn/start(turn 2)
  //   [23] inbox removed=1               ← 它的排空在 turn/start 之后（不在 seed 里）
  //   [26] USER "没什么"                  ← 子会话把它当自己的第 2 轮**重新运行**了
  // 因此只切在 turn/end 不够（会把 [21] 带进来），切在 turn/start 又会丢掉排空；
  // 两者都必须做：seed 切在 turn/start 之前（长度与 inheritedEventCount 严格相等、不追加），
  // 悬挂项在建完后作为普通事件排空。
  const boundaryEvent = record.events.find(event => event.type === 'turn/end' && event.seq >= boundary)
  let cut = boundaryEvent === undefined ? -1 : boundaryEvent.seq + 1
  while (cut >= 0 && cut < record.events.length && record.events[cut]?.type !== 'turn/start')
    cut += 1
  const pendingInSeed = countPendingInbox(record.events.slice(0, Math.max(0, cut)))
  const keptTurns = turns.filter(candidate => candidate.turn <= turn.turn - 1).map(candidate => candidate.turn)
  void logEvent('boundary', 'ok-fork', {
    sessionId: record.id,
    targetTurn: turn.turn,
    anchor: boundary,
    boundarySeq: boundaryEvent?.seq ?? null,
    cutSeq: cut,
    cutEvent: cut >= 0 ? record.events[cut]?.type : null,
    pendingInSeed,
    keptTurns,
    childWillShowTurns: keptTurns,
  })
  return { ok: true, boundary, turn: turn.turn, eventSeq: turn.user.seq, before: userText(turn.user.data), reset: false, prefixLength: cut, pendingInbox: pendingInSeed }
}

/* --------------------------------------------------------- 子会话创建 -- */

/** 源会话所在的侧栏工作区 id（找不到返回 undefined）。 */
function workspaceIdOf(ctx: HostContext, sessionId: string): string | undefined {
  return workspaceFor(ctx, sessionId)?.id
}

/** 源会话所在的工作区实例（registry.list() 里 sessionIds 命中的那个）。 */
function workspaceFor(ctx: HostContext, sessionId: string): { id?: string, attachSession?: (id: string) => Promise<unknown> } | undefined {
  try {
    const registry = ctx.get('workspaceRegistry')
    const list = registry?.list?.()
    if (!Array.isArray(list))
      return undefined
    return list.find((workspace: { sessionIds?: readonly string[] }) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))
  }
  catch {
    return undefined
  }
}

/** 累计 seed 里未排空的 inbox 入队项数（`inserted - removedCount`）。 */
function countPendingInbox(events: readonly SessionEventLike[]): number {
  let pending = 0
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced')
      continue
    const data = event.data as { inserted?: unknown[], removedCount?: number } | undefined
    const inserted = Array.isArray(data?.inserted) ? data.inserted.length : 0
    const removed = typeof data?.removedCount === 'number' ? data.removedCount : 0
    pending = Math.max(0, pending + inserted - removed)
  }
  return pending
}

/** 回合开始之前的系统前言（首轮编辑的 seed）。 */
function preambleOf(events: readonly SessionEventLike[]): SessionEventLike[] {
  const firstTurn = events.findIndex(event => event.type === 'turn/start')
  return events.slice(0, Math.max(0, firstTurn)) as SessionEventLike[]
}

/**
 * 从会话历史解析模型路由（与 REF A `agentOptions` 同一判据：最后一次 `request/header`）。
 *
 * 两端参考实现建子会话时都显式传 `agentOptions:{provider,model}`；不传会让子会话悄悄
 * 掉回全局默认模型，用户编辑后看到的回答可能换了模型。
 */
function modelRouteOptions(events: readonly SessionEventLike[]): Record<string, unknown> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'request/header')
      continue
    const config = (event.data.header as { config?: { provider?: string, model?: string, maxTokens?: number } } | undefined)?.config
    if (config?.provider === undefined || config.model === undefined)
      return undefined
    return {
      provider: config.provider,
      model: config.model,
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    }
  }
  return undefined
}

/**
 * 建好「目标轮之前」的截断子会话，并排空它继承来的悬挂 inbox 入队项。
 *
 * 形状与官方 session/fork 内部一致（dsh-api-session-controller `lib/index.js` 的
 * `agents.create({ seed: source.events.slice(0, cut), inheritedEventCount: cut,
 * meta: { cwd, parentSession, isSeeded: true } })`），差别只在 `cut` 由我们算：
 * 切点在目标轮 `turn/start` 之前，前缀即保留轮的完整日志。
 *
 * 硬约束（内核 dsh-session `lib/index.js` 断言）：`inheritedEventCount` 必须**恰好等于**
 * 本次交给 create 的 seed 条数，否则 `seeded session constructor seed must equal its
 * inherited prefix`（400）。因此**绝不能往 seed 里追加事件**——排空必须走 create 之后的
 * 普通 append（见下）。
 */
async function createChildSession(
  ctx: HostContext,
  source: SessionRecordLike,
  prefixLength: number,
  pendingInbox = 0,
): Promise<string> {
  const seed = source.events.slice(0, Math.max(0, prefixLength)) as SessionEventLike[]
  const childId = `session-${crypto.randomUUID()}`
  // seed 只带「目标轮之前」的前缀，并把继承边界一并声明（与官方 fork 同形）。
  //
  // 首轮（prefixLength = 0）不能退回「前 4 条事件」：那 4 条里最后一条可能正是
  // `agent/inbox/spliced`（原始第一条提问），于是它又会被子会话当成第一轮排空。
  // 首轮只保留**回合开始之前的系统前言**（permission/preset、sandbox/mode、approval/policy…），
  // 一条 user/message 与 inbox 事件都不带；空 seed 无法持久化，前言正好保证有内容。
  const preamble = source.events.slice(0, Math.max(0, source.events.findIndex(event => event.type === 'turn/start')))
  const effectiveSeed = seed.length > 0 ? seed : (preamble as SessionEventLike[])
  // seed 就是切好的前缀，**绝不追加**：内核断言 inheritedEventCount 必须等于 seed 条数
  // （dsh-session `lib/index.js`），往 seed 里塞事件会让持久化重建直接 400。
  const modelRoute = modelRouteOptions(source.events)
  // 工作区：只有 workspaceId 会 attachSession（cwd 只决定运行时目录），
  // 但 workspaceId 与 cwd 互斥——优先 workspaceId，解析不到才用 cwd。
  const workspaceId = workspaceIdOf(ctx, source.id)
  void logEvent('edit', 'child-create-start', {
    childId,
    sourceSession: source.id,
    workspaceId: workspaceId ?? null,
    cwd: source.header.cwd ?? null,
    prefixLength,
    seedEvents: effectiveSeed.length,
    seedLastEvent: effectiveSeed.at(-1)?.type ?? null,
    seedLastSeq: effectiveSeed.at(-1)?.seq ?? null,
    pendingInbox,
  })
  let child: unknown
  try {
    child = await ctx.agents.create({
      sessionId: childId,
      seed: effectiveSeed,
      // 必须恰好等于 seed 条数：内核断言 seeded session 的 inherited prefix 等于日志长度。
      inheritedEventCount: effectiveSeed.length,
      ...(modelRoute === undefined ? {} : { agentOptions: modelRoute }),
      meta: {
        ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
        parentSession: source.id,
        isSeeded: true,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      },
    })
  }
  catch (error) {
    // 创建失败必须留证据：客户端「历史加载失败：session … not found」正是创建没成
    // （或被立刻回滚）时的表现。把内核报错原文落盘，避免再靠现象猜。
    void logEvent('edit', 'child-create-failed', {
      childId,
      sourceSession: source.id,
      workspaceId: workspaceId ?? null,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 400) : null,
    })
    throw error
  }
  void logEvent('edit', 'child-create-ok', { childId, hasSession: (child as { agent?: { session?: unknown } })?.agent?.session !== undefined })
  const childSession = (child as { agent?: { session?: unknown } }).agent?.session
  // 注意：**不再重放**保留轮。seed 已经把它们带进子会话（与官方 session/fork 同一路径），
  // 再 append 一遍会把同一段对话写两次（重复轮次）。
  // ★ 排空 seed 里悬挂的 inbox 入队项 —— 必须作为**建完之后的普通事件**追加，不能塞进 seed。
  //
  // 提问的内核形态：`agent/inbox/spliced {inserted:[提问]}` 入队 → `turn/start` → 之后才排空。
  // 切点在目标轮 `turn/start` 之前时，入队在 seed 里、排空不在 → 子会话 inbox 重建
  // （dsh-agent-loop `inboxProjectionDefinition.apply`：`inbox.toSpliced(start, removedCount, ...inserted)`）
  // 会把这条旧提问「复活」并当成自己的第一轮消费掉 —— 就是「原本的消息又跑了一遍」。
  //
  // 这条 splice 放在 create 之后 append（而不是 seed 里），既把悬挂项清掉，又不改变
  // `inheritedEventCount` 与 seed 长度的对应关系，因此不会触发那个 400 断言。
  if (pendingInbox > 0) {
    try {
      ;(childSession as { append?: (type: string, data: Record<string, unknown>) => unknown } | undefined)
        ?.append?.('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: pendingInbox, inserted: [] })
      void logEvent('edit', 'child-inbox-drained', { childId, removedCount: pendingInbox })
    }
    catch (e) {
      void logEvent('edit', 'child-inbox-drain-failed', { childId, error: String((e as Error)?.message || e) })
    }
  }
  try {
    await ctx.sessions.flush(childSession)
  }
  catch (e) {
    void logEvent('edit', 'child-flush-failed', { childId, error: String((e as Error)?.message || e) })
  }
  // 工作区归属（审计更正）：`meta.workspaceId` 是**惰性元数据**——成员关系存在
  // workspace 记录的 `sessionIds` 里，只有 `attachSession` 会改它；没有内核代码读会话头里的
  // workspaceId。所以无论创建时传没传，都必须显式 attach 一次（官方 fork 也是建完再 attach）。
  try {
    const workspace = workspaceFor(ctx, source.id)
    await workspace?.attachSession?.(childId)
    void logEvent('edit', 'child-attached', { childId, workspace: workspace?.id ?? null, attached: workspace !== undefined })
  }
  catch (e) {
    void logEvent('edit', 'child-attach-failed', { childId, error: String((e as Error)?.message || e) })
  }
  void logEvent('edit', 'child-created', {
    childId,
    parentSession: source.id,
    sourceSession: source.id,
    workspaceId: workspaceId ?? null,
    inheritedEventCount: effectiveSeed.length,
    seedLastSeq: effectiveSeed.at(-1)?.seq ?? null,
    pendingInbox,
  })
  // 核对子会话**实际**的回合数：只为诊断（截断是否真的生效），不参与流程。
  try {
    const childRecord = sessionRecord(ctx.sessions.get(childId))
    const childTurns = closedTurns(childRecord.events)
    void logEvent('edit', 'child-verify', {
      childId,
      expectedEvents: seed.length,
      actualEvents: childRecord.events.length,
      actualTurns: childTurns.map(candidate => candidate.turn),
      inheritedEventCount: childRecord.inheritedEventCount,
      seeded: childRecord.header.isSeeded === true,
      truncationHonored: childRecord.events.length <= seed.length + 2,
    })
  }
  catch (e) {
    void logEvent('edit', 'child-verify-failed', { childId, error: String((e as Error)?.message || e) })
  }
  // 记录服务端复读结果，但**不再**据此把编辑判死：
  // 会话在内存里可读、可打开、可发送；「持久化重建复读」的校验失败只是提示信息，
  // 让编辑失败会把用户卡在错误里（此前就是这样：新会话建好了，却没发送、没切过去）。
  try {
    await ctx.sessionQuery.readSession(childId)
    void logEvent('edit', 'child-server-ok', { childId })
  }
  catch (error) {
    void logEvent('edit', 'child-server-read-warning', {
      childId,
      error: error instanceof Error ? error.message : String(error),
      note: 'continuing anyway',
    })
  }
  return childId
}

/** 读一条会话、解析边界、并**建好**截断后的子会话；返回新会话 id。 */
export async function applyEdit(
  ctx: HostContext,
  sessionId: string,
  turnNumber: number | undefined,
  eventSeq: number | undefined,
): Promise<{ ok: true, childId: string, boundary: number, turn: number, eventSeq: number, reset: boolean } | { ok: false, code: string, message: string }> {
  const record = await loadSessionRecord(ctx, sessionId)
  // 只给了 eventSeq 时，先由事件定位它所在的已闭合回合。
  let turn = turnNumber
  if (turn === undefined) {
    if (eventSeq === undefined)
      return { ok: false, code: 'invalid-target', message: '必须提供 turn 或 eventSeq。' }
    const owner = closedTurns(record.events).find(candidate => eventSeq >= candidate.startSeq && eventSeq <= candidate.endSeq)
    if (owner === undefined)
      return { ok: false, code: 'invalid-target', message: 'eventSeq 不属于任何已闭合回合。' }
    turn = owner.turn
  }
  const result = resolveBoundary(record, turn, eventSeq)
  if (!result.ok)
    return result
  const childId = await createChildSession(ctx, record, result.prefixLength, result.pendingInbox)
  return {
    ok: true,
    childId,
    boundary: result.boundary,
    turn: result.turn,
    eventSeq: result.eventSeq,
    reset: result.reset,
  }
}
