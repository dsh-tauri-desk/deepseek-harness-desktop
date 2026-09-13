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
  = | { ok: true, boundary: number, turn: number, eventSeq: number, before: string, reset: boolean, prefixLength: number }
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
    return { ok: true, boundary: -1, turn: turn.turn, eventSeq: turn.user.seq, before: userText(turn.user.data), reset: true, prefixLength: 0 }
  }
  // 预测官方 fork 的结果，写进日志：boundary = 第一个 seq >= anchor 的 turn/end，
  // cut = 从 boundary 之后推进到下一个 turn/start。这样日志能直接说明子会话会保留
  // 哪几轮，不必再猜「晚了一个节点」是保留多了还是少了。
  const boundaryEvent = record.events.find(event => event.type === 'turn/end' && event.seq >= boundary)
  let cut = boundaryEvent === undefined ? -1 : boundaryEvent.seq + 1
  while (cut >= 0 && cut < record.events.length && record.events[cut]?.type !== 'turn/start')
    cut += 1
  const keptTurns = closedTurns(record.events as SessionEventLike[]).filter(candidate => cut >= 0 && candidate.endSeq < cut).map(candidate => candidate.turn)
  void logEvent('boundary', 'ok-fork', {
    sessionId: record.id,
    targetTurn: turn.turn,
    anchor: boundary,
    boundarySeq: boundaryEvent?.seq ?? null,
    cutSeq: cut,
    cutEvent: cut >= 0 ? record.events[cut]?.type : null,
    keptTurns,
    childWillShowTurns: keptTurns,
  })
  return { ok: true, boundary, turn: turn.turn, eventSeq: turn.user.seq, before: userText(turn.user.data), reset: false, prefixLength: cut }
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
): Promise<string> {
  const seed = source.events.slice(0, Math.max(0, prefixLength)) as SessionEventLike[]
  const childId = `session-${crypto.randomUUID()}`
  await ctx.agents.create({
    sessionId: childId,
    seed,
    inheritedEventCount: seed.length,
    meta: {
      ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
      parentSession: source.id,
      isSeeded: true,
    },
  })
  void logEvent('edit', 'child-created', {
    childId,
    parentSession: source.id,
    prefixLength: seed.length,
    seedFirstSeq: seed[0]?.seq ?? null,
    seedLastSeq: seed.at(-1)?.seq ?? null,
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
  const childId = await createChildSession(ctx, record, result.prefixLength)
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
