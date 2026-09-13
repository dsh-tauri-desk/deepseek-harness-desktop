/**
 * host/service/edit-session.ts — 边界解析（宿主半区，只读）。
 *
 * 与 DSH-EasyRewrite 的宿主半区一致：这里**不碰 Agent**——不 resume、不 create、
 * 不 followup。它只读会话日志，算出「该消息之前最后一个闭合回合」的边界，交给客户端
 * 用官方 RPC 自行 fork。这样源会话绝不会被重新激活，也就不会出现「编辑后整段对话
 * 又被跑一遍」。
 *
 * 另外提供 GET 的版本树投影（‹ n/m › 与版本图的数据面），同样只读。
 *
 * 上游来源：dsh-plugin-message-edit 的 `message-tree` 协议（MIT © SpookySandwich）
 * 与 dsh-easyrewrite 的边界判定（MIT © Renzic-Stone）。
 */

import type {
  HostContext,
  SessionEventLike,
  SessionRecordLike,
  TurnLike,
  VersionLike,
} from '../types'
import { MESSAGE_TREE_EVENT, MESSAGE_TREE_SCHEMA } from '../../shared/constants'
import { logEvent } from './debug-log'
import { loadSessionRecord, sessionEventCount, sessionRecord } from './session-record'
import { ancestorChainFromLog, collectFamily } from './tree-logic'

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

/** 读一条会话并解析边界。 */
export async function planEdit(ctx: HostContext, sessionId: string, turnNumber: number | undefined, eventSeq: number | undefined): Promise<BoundaryResult> {
  const record = await loadSessionRecord(ctx, sessionId)
  void logEvent('plan', 'input', { sessionId, turn: turnNumber ?? null, eventSeq: eventSeq ?? null, eventsLength: record.events.length, inheritedEventCount: record.inheritedEventCount, headerParent: record.header.parentSession ?? null })
  if (turnNumber === undefined) {
    // 只给了 eventSeq：先由事件定位它所在的已闭合回合。
    if (eventSeq === undefined)
      return { ok: false, code: 'invalid-target', message: '必须提供 turn 或 eventSeq。' }
    const owner = closedTurns(record.events).find(t => eventSeq >= t.startSeq && eventSeq <= t.endSeq)
    if (owner === undefined)
      return { ok: false, code: 'invalid-target', message: 'eventSeq 不属于任何已闭合回合。' }
    turnNumber = owner.turn
  }
  const result = resolveBoundary(record, turnNumber, eventSeq)
  // 内核 fork 读的是 `sessionQuery.observeSession`（持久化视角）。核对同一视角：
  // 若它返回的 events 里找不到 anchor 之后第一个 `turn/end`，fork 会兜底到
  // findLast（= 整段历史都被复制）。这条日志是判定 fork 是否真按 atSeq 截断的直接证据。
  if (result.ok && !result.reset) {
    try {
      const observed = await ctx.sessionQuery.observeSession(sessionId) as { events?: any[] } | undefined
      const obsEvents = observed?.events ?? []
      const obsBoundary = obsEvents.find(event => event.type === 'turn/end' && event.seq >= result.boundary)
      void logEvent('boundary', 'observe-check', {
        sessionId,
        anchor: result.boundary,
        liveEvents: record.events.length,
        observedEvents: obsEvents.length,
        observedFirstSeq: obsEvents[0]?.seq ?? null,
        observedLastSeq: obsEvents.at(-1)?.seq ?? null,
        observedHasAnchorTurnEnd: obsBoundary !== undefined,
        observedBoundarySeq: obsBoundary?.seq ?? null,
      })
    }
    catch (e) {
      void logEvent('boundary', 'observe-check-failed', { sessionId, error: String((e as Error)?.message || e) })
    }
  }
  return result
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
 * 排空 seed 末尾悬挂的 inbox 插入（见 createChildSession 里的长注释）。
 *
 * 扫描 seed 里 `agent/inbox/spliced` 的净入队量：`inserted.length - removedCount` 的累计。
 * 若末尾仍有未排空的项，就补一条 `removedCount = 未排空数` 的 spliced 事件把它清掉，
 * 使子会话的 inbox 从零开始（改后的文本才会成为第一轮）。
 */
function drainPendingInbox(seed: SessionEventLike[]): SessionEventLike[] {
  let pending = 0
  for (const event of seed) {
    if (event.type !== 'agent/inbox/spliced')
      continue
    const data = event.data as { inserted?: unknown[], removedCount?: number } | undefined
    const inserted = Array.isArray(data?.inserted) ? data.inserted.length : 0
    const removed = typeof data?.removedCount === 'number' ? data.removedCount : 0
    pending = Math.max(0, pending + inserted - removed)
  }
  if (pending === 0)
    return seed
  const last = seed[seed.length - 1]
  const start = typeof (last?.data as { start?: number } | undefined)?.start === 'number'
    ? (last?.data as { start: number }).start
    : 0
  const drain: SessionEventLike = {
    type: 'agent/inbox/spliced',
    seq: seed.length,
    time: Date.now(),
    data: { target: 'next-turn', start: 0, removedCount: pending, inserted: [] },
    ignorable: true,
  } as unknown as SessionEventLike
  void start
  return [...seed, drain]
}

/**
 * 用**内核自己的 fork 原语**建子会话：`ctx.agents.create({ seed })`。
 *
 * 为什么不用客户端 `sessions.fork({ atSeq })`：dev 内核（0.1.5-rc.1）实测**忽略 atSeq**
 * ——父会话只有 3 轮，`atSeq=18` 之后建出的子会话却有 4 轮（被编辑掉的那一轮连同原样
 * 回复全被复制）。对真实日志比对 assistant 时间戳可证：子会话 seq 16 的时间戳与父会话
 * **完全相同**（继承），而后续轮次是新生成的。
 *
 * 官方 session/fork 内部也正是这么建子会话的（dsh-api-session-controller
 * `lib/index.js:696-711`）：
 *   agents.create({ sessionId, seed: source.events.slice(0, cut),
 *                   inheritedEventCount: cut, meta: { parentSession, isSeeded: true } })
 * 这里照抄同一形状，但 `cut` 由我们按「目标轮之前」精确计算，因此不受 fork 的
 * 「必须切在一轮末尾」限制。
 *
 * 硬约束：`inheritedEventCount` 必须等于 seed 长度。内核断言
 * `seeded session constructor seed must equal its inherited prefix`，多一条/少一条都 409。
 */
async function createChildSession(
  ctx: HostContext,
  source: SessionRecordLike,
  prefixLength: number,
  pendingInbox = 0,
): Promise<string> {
  const seed = source.events.slice(0, Math.max(0, prefixLength)) as SessionEventLike[]
  const childId = `session-${crypto.randomUUID()}`
  // 恢复**继承通道**（用户要求）：与官方 `session/fork` 和上游 dsh-plugin-message-edit
  // 完全同形——seed 只带「目标轮之前」的前缀，并把继承边界一并声明。
  //
  // 首轮（prefixLength = 0）不能退回「前 4 条事件」：那 4 条里最后一条可能正是
  // `agent/inbox/spliced`（原始第一条提问），于是它又会被子会话当成第一轮排空。
  // 首轮只保留**回合开始之前的系统前言**（permission/preset、sandbox/mode、approval/policy…），
  // 一条 user/message 与 inbox 事件都不带；空 seed 无法持久化，前言正好保证有内容。
  const preamble = source.events.slice(0, Math.max(0, source.events.findIndex(event => event.type === 'turn/start')))
  const effectiveSeed = seed.length > 0 ? seed : (preamble as SessionEventLike[])
  // seed 就是切好的前缀，**绝不追加**：内核断言 `inheritedEventCount === log.length`
  // （dsh-session/lib/index.js:1084），往 seed 里塞事件会让持久化重建直接 400。
  const drainedSeed = effectiveSeed
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
    drainedEvents: drainedSeed.length,
    lastSeedEvent: drainedSeed.at(-1)?.type ?? null,
    lastSeedSeq: drainedSeed.at(-1)?.seq ?? null,
    firstSeedSeq: drainedSeed[0]?.seq ?? null,
  })
  let child: unknown
  try {
    child = await ctx.agents.create({
      sessionId: childId,
      seed: drainedSeed,
      // 必须等于**实际交给 create 的** seed 长度（含末尾那条排空事件）：内核断言
      // `seeded session constructor seed must equal its inherited prefix`。
      inheritedEventCount: drainedSeed.length,
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
    inheritedEventCount: drainedSeed.length,
    seedFirstSeq: drainedSeed[0]?.seq ?? null,
    seedLastSeq: drainedSeed.at(-1)?.seq ?? null,
    pendingInbox,
  })
  // 立刻核对子会话**实际**的事件数量：内核若忽略 seed，这里就会远大于 seed.length。
  // 这是判定「截断是否真的生效」的唯一权威读数（不依赖任何客户端）。
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

/* ------------------------------------------------------------- 树投影 -- */

/** 一条会话自己的版本标记（按继承边界过滤，嵌套分支不会误认祖先的标记）。 */
function ownVersionEvent({ header, events, inheritedEventCount: inherited }: SessionRecordLike): { effect: Record<string, unknown>, time: number } | undefined {
  const ownEvents = events.filter(event => event.type === MESSAGE_TREE_EVENT && event.seq >= inherited)
  if (ownEvents.length === 0)
    return undefined
  const event = ownEvents[0]
  const version = event.data as { schemaVersion?: number, effect?: Record<string, unknown>, inverse?: { kind?: string, sessionId?: string } }
  const parent = header.parentSession
  if (version.schemaVersion !== MESSAGE_TREE_SCHEMA)
    throw new Error(`会话 ${header.id} 使用不支持的版本效果结构。`)
  if (version.inverse?.kind !== 'restore-version' || parent === undefined || version.inverse.sessionId !== parent)
    throw new Error(`会话 ${header.id} 的版本效果与逆不匹配。`)
  return { effect: version.effect as Record<string, unknown>, time: event.time }
}

/** 有界并发读。 */
const TREE_READ_CONCURRENCY = 4
async function mapConcurrent<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let cursor = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length)
        return
      const item = items[index] as T
      results[index] = await worker(item)
    }
  }
  const workers = Math.min(TREE_READ_CONCURRENCY, items.length)
  await Promise.all(Array.from({ length: workers }, () => run()))
  return results
}

/** 从一条会话的事件流里提取全部用户回合（含开放尾巴）。 */
export function extractTurns(events: readonly SessionEventLike[]): Array<{ turn: number, text: string, time: number }> {
  if (!Array.isArray(events))
    return []
  const result: Array<{ turn: number, text: string, time: number }> = []
  let current: { turn: number, startSeq: number, time: number, user?: SessionEventLike, text?: string } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn as number, startSeq: event.seq, time: event.time }
      continue
    }
    if (current === undefined)
      continue
    if (event.type === 'user/message' && current.user === undefined && (event.data?.source as { kind?: string } | undefined)?.kind === 'user') {
      current.user = event
      current.text = userText(event.data)
      current.time = event.time ?? current.time
      continue
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      result.push({ turn: current.turn, text: current.text ?? '', time: current.time ?? event.time })
      current = undefined
    }
  }
  if (current && current.user)
    result.push({ turn: current.turn, text: current.text ?? '', time: current.time ?? Date.now() })
  return result
}

/** 解析缓存上限与会话 id → 解析结果的缓存（按 ctx 分桶）。 */
const SESSION_CACHE_MAX = 500
const sessionParsedCaches = new WeakMap<object, Map<string, any>>()

/** 一条会话的回合列表 + 自己的版本效果（带缓存）。 */
async function sessionParsedData(ctx: HostContext, record: any): Promise<{ key: number, turns: any[], effect?: any, time?: number }> {
  if (!record || !record.header)
    return { key: -1, turns: [], effect: undefined, time: undefined }
  const id = record.header.id
  let sessionParsedCache = sessionParsedCaches.get(ctx)
  if (!sessionParsedCache) {
    sessionParsedCache = new Map()
    sessionParsedCaches.set(ctx, sessionParsedCache)
  }
  const live = ctx.sessions.get(id)
  // 冷日志长出来时 header 创建时间永不变。按长度缓存前先读冷快照；活日志提供廉价计数。
  const snapshot = live === undefined ? await loadSessionRecord(ctx, id) : undefined
  const key = live === undefined ? (snapshot as SessionRecordLike).events.length : sessionEventCount(live)
  const cached = sessionParsedCache.get(id)
  if (cached !== undefined && cached.key === key && cached.live?.deref() === live)
    return cached

  const source = snapshot ?? sessionRecord(live)
  const events = source.events
  const turns = extractTurns(events)
  let effect: any
  let time: number | undefined
  try {
    const version = ownVersionEvent(source)
    effect = version?.effect
    time = version?.time
  }
  catch {
    effect = undefined
  }

  const entry = { key, live: live === undefined ? undefined : new WeakRef(live), turns, effect, time }
  if (sessionParsedCache.size >= SESSION_CACHE_MAX) {
    const firstKey = sessionParsedCache.keys().next().value
    if (firstKey !== undefined)
      sessionParsedCache.delete(firstKey)
  }
  sessionParsedCache.set(id, entry)
  return entry
}

/** 已归档会话 id 集合；注册表读不到时为空集。 */
function archivedSessionIdSet(ctx: HostContext): Set<string> {
  try {
    const ids = ctx.get('workspaceRegistry')?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids : [])
  }
  catch {
    return new Set()
  }
}

/** 一条会话完整日志里的全部 message-tree/version 事件，按 seq 排序。 */
async function versionMarkers(ctx: HostContext, sessionId: string): Promise<Record<string, unknown>[]> {
  const { events } = await loadSessionRecord(ctx, sessionId)
  return (events as unknown as Array<Record<string, unknown>>).filter(event => event.type === MESSAGE_TREE_EVENT)
}

/**
 * 组装一个会话家族，桥接用户已删除的会话（沿用上游 `assembleFamily` 的算法）。
 */
async function assembleFamily(ctx: HostContext, sessionId: string): Promise<{
  rootId: string
  flat: Array<{ entry: any, depth: number }>
  recordsById: Map<string, any>
}> {
  const records = await ctx.sessionQuery.listSessions() as Array<{ header: any }>
  const recordsById = new Map<string, any>(records.map(record => [record.header.id, record]))
  const target = recordsById.get(sessionId)
  if (target === undefined)
    throw new Error(`session "${sessionId}" not found`)

  const ghostInfo = new Map<string, { marker?: Record<string, unknown>, parentId?: string }>()
  const absorbChain = (chain: Array<{ sessionId: string, marker?: Record<string, unknown> }>): void => {
    for (let i = 0; i < chain.length; i++) {
      const link = chain[i]
      if (recordsById.has(link.sessionId))
        continue
      const info = ghostInfo.get(link.sessionId) ?? {}
      if (link.marker !== undefined)
        info.marker = link.marker
      if (i + 1 < chain.length)
        info.parentId = chain[i + 1].sessionId
      ghostInfo.set(link.sessionId, info)
    }
  }

  let rootId: string
  {
    const seen = new Set<string>()
    let cursor = target.header
    while (cursor.parentSession !== undefined && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      const parent = recordsById.get(cursor.parentSession)
      if (parent === undefined)
        break
      cursor = parent.header
    }
    rootId = cursor.id
    if (cursor.parentSession !== undefined) {
      const chain = ancestorChainFromLog(cursor.parentSession, await versionMarkers(ctx, cursor.id))
      absorbChain(chain)
      if (chain.length > 0)
        rootId = chain[chain.length - 1].sessionId
    }
  }

  for (const record of records) {
    const parentId = record.header.parentSession
    if (parentId === undefined || recordsById.has(parentId))
      continue
    if (record.header.cwd !== target.header.cwd)
      continue
    if (record.header.id === sessionId)
      continue
    try {
      absorbChain(ancestorChainFromLog(parentId, await versionMarkers(ctx, record.header.id)))
    }
    catch {
      // 读不出来的孤儿就让它当孤岛。
    }
  }

  const entries: any[] = []
  for (const record of records) {
    if (record.header.cwd !== target.header.cwd && record.header.id !== sessionId)
      continue
    entries.push({
      id: record.header.id,
      ...(record.header.parentSession === undefined ? {} : { parentId: record.header.parentSession }),
      createdAt: record.header.createdAt,
      ghost: false,
    })
  }
  for (const [id, info] of ghostInfo) {
    entries.push({
      id,
      ...(info.parentId === undefined ? {} : { parentId: info.parentId }),
      createdAt: (info.marker?.time as number | undefined) ?? 0,
      ghost: true,
      ...(info.marker === undefined ? {} : { marker: info.marker }),
    })
  }
  return { rootId, flat: collectFamily(rootId, entries), recordsById }
}

/** 投影整棵版本树（客户端 ‹ › 环与版本图的数据面）。 */
export async function readTree(ctx: HostContext, sessionId: string): Promise<{ sessionId: string, versions: VersionLike[] }> {
  const { flat, recordsById } = await assembleFamily(ctx, sessionId)
  const archived = archivedSessionIdSet(ctx)
  const parsedLogs = await mapConcurrent(flat, async ({ entry }) => {
    if (entry.ghost)
      return null
    const record = recordsById.get(entry.id)
    return record === undefined ? null : sessionParsedData(ctx, record)
  })
  const parentOf = new Map(flat.map(({ entry }) => [entry.id, entry.parentId]))
  const currentPath = new Set<string>()
  let pathId: string | undefined = sessionId
  while (pathId !== undefined && !currentPath.has(pathId)) {
    currentPath.add(pathId)
    pathId = parentOf.get(pathId)
  }
  const versions: VersionLike[] = flat.map(({ entry, depth }, index) => {
    let effect: any
    let time: number | undefined
    let turns: any[] = []
    if (entry.ghost) {
      effect = (entry.marker as any)?.data?.effect
      time = (entry.marker as any)?.time
    }
    else {
      const parsed = parsedLogs[index]
      turns = parsed?.turns ?? []
      effect = parsed?.effect
      time = parsed?.time
    }
    const record = entry.ghost ? undefined : recordsById.get(entry.id)
    return {
      sessionId: entry.id,
      ...(entry.parentId === undefined ? {} : { parentSessionId: entry.parentId }),
      createdAt: time ?? record?.header.createdAt ?? entry.createdAt,
      depth,
      current: entry.id === sessionId,
      onCurrentPath: currentPath.has(entry.id),
      ...(entry.ghost ? { deleted: true } : {}),
      ...(archived.has(entry.id) ? { archived: true } : {}),
      ...(effect === undefined
        ? {}
        : {
            operation: effect.operation,
            targetTurn: effect.targetTurn,
            targetEventSeq: effect.targetEventSeq,
            ...(effect.before === undefined ? {} : { before: effect.before }),
            ...(effect.after === undefined ? {} : { after: effect.after }),
          }),
      turns,
    }
  })
  return { sessionId, versions }
}
