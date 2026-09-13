/**
 * host/service/edit-session.ts — 上游 dsh-plugin-message-edit 宿主逻辑的逐字移植。
 *
 * 逐字移植 `source/dsh-plugin-message-edit/lib/index.js`（MIT © SpookySandwich，
 * 其分支事务形状源自 dsh-message-edit / MIT © Moeblack），只做三处适配：
 *   1. HTTP 管道换成 dsh-tauri 的 routeHandler / withConnectionAuth（见 host/routes）；
 *   2. `edit` 操作额外接受 `turn` 定位（DOM 注入路径读不到事件 seq，只有
 *      `data-chat-turn`）；
 *   3. TS 类型标注。逻辑、常量与注释一律保留原文。
 *
 * POST 建一条版本分支：用「被编辑轮次之前的全部事件」做种子建新会话（真正的倒带，
 * 不同于客户端 session.fork 的「切在一轮之后」），写入持久化 `message-tree/version`
 * 标记说明改了什么，并把改后的提问排队等一次全新回答。GET 投影整棵版本树，供客户端的
 * ‹ › 环与版本图使用。
 */

import type {
  EditPlanLike,
  EditSessionResponse,
  HostContext,
  MessageOperationLike,
  SessionEventLike,
  SessionRecordLike,
  TurnLike,
  VersionEntryLike,
  VersionLike,
} from '../types'
import { MESSAGE_TREE_EVENT, MESSAGE_TREE_SCHEMA } from '../../shared/constants'
import { branchSeedOptions, loadSessionRecord, sessionEventCount, sessionRecord, sessionRecordId } from './session-record'
import { ancestorChainFromLog, attachParentId, collectFamily } from './tree-logic'

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

/** 克隆一条用户消息（默认原样复制内容）。 */
function cloneUser(message: Record<string, unknown>, content?: unknown[]): Record<string, unknown> {
  const blocks = content ?? structuredClone(message.content as unknown[])
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze(blocks),
    source: Object.freeze({ kind: 'user' }),
  })
}

/** 替换第 blockIndex 个文本块。 */
function replaceTextBlock(content: readonly unknown[], blockIndex: number, text: string): unknown[] {
  const block = content[blockIndex] as { type?: string } | undefined
  if (block?.type !== 'text')
    throw new TypeError('所选内容块不是可编辑文本。')
  return content.map((candidate, index) => index === blockIndex
    ? { ...(candidate as object), text }
    : structuredClone(candidate))
}

/** 第一条文本块的索引（DOM 注入路径不带 blockIndex 时由宿主补）。 */
function firstTextBlock(content: unknown): number {
  if (!Array.isArray(content))
    return -1
  for (let index = 0; index < content.length; index += 1) {
    if ((content[index] as { type?: string } | undefined)?.type === 'text')
      return index
  }
  return -1
}

/* ---------------------------------------------------------------- 规划 -- */

/** 版本效果对：正向效果 + 恢复到源会话的逆。 */
function pairVersionEffect(sourceSessionId: string, effect: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: MESSAGE_TREE_SCHEMA,
    effect: { ...effect, id: crypto.randomUUID() },
    inverse: { kind: 'restore-version', sessionId: sourceSessionId },
  }
}

/** 编辑用户消息：倒带到它的回合之前，排入改后的提问。 */
function editPlan(operation: MessageOperationLike, turns: readonly TurnLike[]): EditPlanLike {
  const turn = typeof operation.turn === 'number'
    ? turns.find(candidate => candidate.turn === operation.turn)
    : turns.find(candidate => operation.eventSeq! > candidate.startSeq && operation.eventSeq! < candidate.endSeq)
  if (turn === undefined)
    throw new TypeError('所选消息不属于已落定回合。')
  if (turn.user === undefined)
    throw new TypeError('所选消息不是用户消息。')
  if (typeof operation.turn !== 'number' && turn.user.seq !== operation.eventSeq)
    throw new TypeError('所选消息不是用户消息。')
  const blockIndex = typeof operation.blockIndex === 'number' ? operation.blockIndex : firstTextBlock(turn.user.data.content)
  const before = (turn.user.data.content as Array<{ type?: string, text?: string }>)[blockIndex]
  if (blockIndex === -1 || before?.type !== 'text')
    throw new TypeError('所选用户消息块不是文本。')
  const edited = cloneUser(turn.user.data, replaceTextBlock(turn.user.data.content as unknown[], blockIndex, operation.text!))
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(operation.sessionId, {
      operation: 'edit',
      targetTurn: turn.turn,
      targetEventSeq: turn.user.seq,
      before: before.text,
      after: operation.text,
    }),
    queuedUsers: [edited],
  }
}

/** 重跑一轮：倒带到它之前，重新排入原提问。 */
function retryPlan(sessionId: string, turnNumber: number, turns: readonly TurnLike[]): EditPlanLike {
  const turn = turns.find(candidate => candidate.turn === turnNumber)
  if (turn?.user === undefined)
    throw new TypeError('所选回合没有可重放的用户输入。')
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(sessionId, {
      operation: 'retry',
      targetTurn: turn.turn,
      targetEventSeq: turn.user.seq,
      before: userText(turn.user.data),
    }),
    queuedUsers: [cloneUser(turn.user.data)],
  }
}

/** 按操作类型规划一次分支。 */
export function planOperation(operation: MessageOperationLike, events: readonly SessionEventLike[]): EditPlanLike {
  const turns = closedTurns(events)
  switch (operation.action) {
    case 'edit': return editPlan(operation, turns)
    case 'retry': return retryPlan(operation.sessionId, operation.turn!, turns)
    default: throw new TypeError('action 必须是 edit 或 retry。')
  }
}

/* ------------------------------------------------------------ 分支创建 -- */

/** 从会话历史解析模型路由（最后一次 request/header，其次 agent options）。 */
function agentOptions(events: readonly SessionEventLike[], fallback?: Record<string, unknown>): Record<string, unknown> {
  // 等价于上游的 events.findLast(…)：仓库 tsconfig 的 lib 是 ES2022，
  // 没有 findLast 的类型与实现，因此显式倒序遍历。
  let lastHeader: Record<string, unknown> | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/header') {
      lastHeader = event.data.header as Record<string, unknown>
      break
    }
  }
  const config = (lastHeader as { config?: { provider?: string, model?: string, maxTokens?: number } } | undefined)?.config
  const provider = config?.provider ?? fallback?.provider as string | undefined
  const model = config?.model ?? fallback?.model as string | undefined
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0)
    throw new TypeError('无法从会话历史解析模型路由。')
  const maxTokens = config?.maxTokens ?? fallback?.maxTokens as number | undefined
  return { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }) }
}

/** 在源 Agent 的维护窗内执行（`runMaintenance` 要求 agent 空闲）。 */
async function withSourceAgent<T>(ctx: HostContext, sessionId: string, operation: (agent: any) => Promise<T>): Promise<T> {
  let handle: any
  let agent = ctx.agents.get(sessionId)
  if (agent === undefined) {
    const snapshot = sessionRecord(await ctx.sessionQuery.readSession(sessionId))
    handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: agentOptions(snapshot.events),
    })
    agent = handle.agent
  }
  try {
    return await agent.runMaintenance(async () => operation(agent))
  }
  finally {
    await handle?.dispose()
  }
}

/** seed = 边界（含）之前的全部事件；边界必须连续。 */
function inheritedSeed(source: SessionRecordLike, boundary: number): SessionEventLike[] {
  if (boundary === -1)
    return []
  const boundaryEvent = source.events[boundary]
  if (boundary < 0 || boundaryEvent === undefined || boundaryEvent.seq !== boundary)
    throw new TypeError('分支边界不是连续会话事件。')
  return source.events.slice(0, boundary + 1) as SessionEventLike[]
}

/**
 * seed + 持久化版本标记。
 *
 * `inheritedLength` 必须等于实际交给 `agents.create` 的 seed 长度（含标记事件）：
 * 内核会话构造函数会断言 `seeded session constructor seed must equal its inherited
 * prefix`（dsh-session/lib/index.js），少一条就会让创建直接 409。
 */
function versionSeed(source: SessionRecordLike, plan: EditPlanLike): { events: SessionEventLike[], inheritedLength: number } {
  const events = inheritedSeed(source, plan.boundary)
  events.push({
    type: MESSAGE_TREE_EVENT,
    seq: events.length,
    time: Date.now(),
    data: plan.version,
    // 插件事件类型在宿主词表之外；缺这个标记读取端会拒绝解释整份日志。
    ignorable: true,
  } as unknown as SessionEventLike)
  return { events, inheritedLength: events.length }
}

/** 源会话的 agent preset（最后一条 agent-preset/selected，其次 header）。 */
function sessionPreset(session: SessionRecordLike): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'agent-preset/selected')
      return event.data.agentPreset as string
  }
  return session.header.agentPreset
}

/** 会话自己的版本标记里的目标轮次。 */
function sessionTargetTurn(session: SessionRecordLike): number | undefined {
  return ownVersionEvent(session)?.effect.targetTurn as number | undefined
}

/**
 * 同一条消息被反复编辑时必须挂在原版上，而不是挂在上一次编辑上。
 * 沿父链向上走，停在第一个**不是** `targetTurn` 版本的会话。
 */
async function resolveAttachSession(ctx: HostContext, sourceSession: SessionRecordLike, targetTurn: number): Promise<any> {
  const nodes = new Map<string, any>()
  let session: any = sourceSession
  const seen = new Set<string>()
  while (session) {
    const id = sessionRecordId(session)
    if (id === undefined || seen.has(id))
      break
    seen.add(id)
    nodes.set(id, {
      targetTurn: sessionTargetTurn(session),
      parentSessionId: session.header.parentSession,
      session,
    })
    const parentId = session.header.parentSession
    if (parentId === undefined || nodes.has(parentId))
      break
    session = await loadSessionRecord(ctx, parentId)
  }
  const byId = new Map([...nodes].map(([id, node]) => [id, {
    targetTurn: node.targetTurn,
    parentSessionId: node.parentSessionId,
  }]))
  const attachId = attachParentId(byId, sessionRecordId(sourceSession) as string, targetTurn)
  return nodes.get(attachId)?.session ?? sourceSession
}

/** 创建版本会话（`agents.create` 的 seed 事务缝）。 */
async function createVersionAgent(
  ctx: HostContext,
  source: SessionRecordLike,
  childId: string,
  plan: EditPlanLike,
  options: Record<string, unknown>,
): Promise<any> {
  const seed = versionSeed(source, plan)
  const presets = ctx.get('agentPresets')
  const presetId = sessionPreset(source)
  let agentPreset: string | undefined
  let setup: ((agentCtx: unknown) => Promise<void>) | undefined
  if (presets !== undefined && presetId !== undefined) {
    const resolved = (await presets.resolve(presetId)).id
    agentPreset = resolved
    setup = async (agentCtx: unknown) => {
      await presets.mount(agentCtx, resolved)
    }
  }
  const seedOptions = branchSeedOptions(source, seed.inheritedLength)
  const child = await ctx.agents.create({
    sessionId: childId,
    seed: seed.events,
    ...seedOptions,
    meta: {
      ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
      parentSession: (source as any).id ?? source.header.id,
      ...seedOptions.meta,
      // 注意：刻意**不是** `origin: 'subagent'`，也刻意不从侧栏隐藏。
      //
      // 两种隐藏方式都已知有害：
      //
      //  - `origin: 'subagent'` 能让版本不出现在侧栏（工作区列表按
      //    `origin !== 'subagent'` 过滤），但 API 代理对同一字段设了栅栏：
      //    `hasApiRemoteSubagentOwner` 会把这种会话当成由 subagent 路由持有，
      //    于是 `session.cancel` 与模型选择都被拒绝
      //      agent-busy: session "..." is owned by subagent routing
      //    每条编辑或重试的消息都变得无法停止。schema 也没有第三个 origin 值
      //    可以藏。
      //
      //  - 归档子会话（`workspaceRegistry.archiveSession`）能隐藏它且没有栅栏，
      //    但应用无法**导航**到已归档会话：打开会被弹回工作区选择器，于是编辑、
      //    重试与版本切换全都死在首页。
      //
      // 因此版本会以普通会话出现在侧栏。这只是外观问题；停止、切换模型与导航都正常。
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
    agentOptions: options,
    ...(setup === undefined ? {} : { setup }),
  })
  try {
    await ctx.sessions.flush(child.agent.session)
    return child
  }
  catch (error) {
    await child.dispose()
    throw error
  }
}

/** 逆序恢复（组合逆）。 */
async function recoverOperation(inverses: Array<() => void | Promise<void>>): Promise<void> {
  const failures: unknown[] = []
  for (const inverse of inverses.reverse()) {
    try {
      await inverse()
    }
    catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, '版本操作恢复失败。')
}

/**
 * 停掉 `sessionId` 上仍在生成的回合，以便从它分叉出去。
 *
 * 两个原因：编辑会从源会话分叉但不会停掉它，被取代的回合会继续流式输出并烧 token；
 * 而且 `runMaintenance` 在 agent 非空闲时会直接抛错（这也是「回合进行中无法编辑」的根因）。
 *
 * 取消父会话同时会停掉它的子代理：子代理会话被 subagent 路由栅栏挡住普通取消路径
 * （"owned by subagent routing"），但整棵子树归父代理的 fiber 所有，会随它一起退场。
 *
 * `cancel` 只发出中止信号；`whenIdle` 等阶段真正落定，否则随后的 `runMaintenance`
 * 仍可能抛错。
 */
async function stopRunningTurn(ctx: HostContext, sessionId: string): Promise<boolean> {
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined)
    return false
  try {
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    return true
  }
  catch {
    // 已经在收尾的 agent 不算错误：目标只是它不再运行。
    return false
  }
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

/**
 * 取消归档一条会话，让应用可以导航到它。
 *
 * 应用无法打开已归档会话（会弹回工作区选择器），而把版本归档以清理侧栏是很自然的事，
 * 所以把环翻到这种版本上时必须先取消归档。这个 dsh 构建没有任何取消归档 API
 * （注册表的 archiveSession 只会加），因此这里镜像 archiveSession 自己的状态纪律：
 * 同一个操作队列、同一份持久状态写入。API 代理监视该状态并广播
 * host/archived-sessions-changed，于是侧栏会实时更新。
 */
async function activateVersion(ctx: HostContext, sessionId: string): Promise<{ unarchived: boolean }> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined)
    throw new Error('workspaceRegistry 不可用，无法取消归档。')
  if (!registry.archivedSessionIds.includes(sessionId))
    return { unarchived: false }
  if (typeof registry.enqueueOperation !== 'function'
    || typeof registry.requireState !== 'function'
    || typeof registry.setState !== 'function') {
    throw new TypeError('此 dsh 版本未提供取消归档的途径。')
  }
  await registry.enqueueOperation(async () => {
    const state = registry.requireState()
    if (!state.archivedSessionIds.includes(sessionId))
      return
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id: string) => id !== sessionId),
    })
  })
  return { unarchived: true }
}

/**
 * 让版本留在与其树父相同的侧栏工作区分组里。
 * 版本继承父的 cwd，但从未挂到它的工作区上，于是显示成散落的未分组行。
 * 失败只是外观问题——版本两种情况下都能用——所以它绝不让编辑失败。
 */
async function attachToParentWorkspace(ctx: HostContext, parentId: string, childId: string): Promise<void> {
  try {
    const registry = ctx.get('workspaceRegistry')
    const workspace = registry?.list().find((w: { sessionIds: string[] }) => w.sessionIds.includes(parentId))
    if (workspace !== undefined)
      await workspace.attachSession(childId)
  }
  catch {
    // 外观问题，忽略。
  }
}

/** 一条会话完整日志里的全部 message-tree/version 事件，按 seq 排序。 */
async function versionMarkers(ctx: HostContext, sessionId: string): Promise<Record<string, unknown>[]> {
  const { events } = await loadSessionRecord(ctx, sessionId)
  return (events as unknown as Array<Record<string, unknown>>).filter(event => event.type === MESSAGE_TREE_EVENT)
}

/**
 * 组装一个会话家族，桥接用户已删除的会话。
 *
 * dsh 的 traceSession 会在第一个缺失的父节点处停下，所以删掉一个版本会把家族打散：
 * 被删原版的兄弟会彻底丢掉 ‹k/N› 计数，被删链节之下的一切会从版本树消失。但每个版本的
 * seed 都继承祖先的 `message-tree/version` 标记，所以被删祖先的身份、父会话与目标回合
 * 都存活在后代日志里。这里优先走存活 header，其余从这些标记恢复，为已删除会话发出
 * ghost 条目，让树保持完整。
 *
 * 家族从不跨工作目录（版本继承源的 cwd），所以目标 cwd 之外的孤儿日志从不读取。
 */
async function assembleFamily(ctx: HostContext, sessionId: string): Promise<{
  rootId: string
  flat: Array<{ entry: VersionEntryLike, depth: number }>
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

  // 目标的根：优先存活 header，在破洞处用日志桥接。
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

  // 同一 cwd 下其它孤儿可能通过自己的破洞属于这个家族；每个孤儿的日志都写着
  // 自己完整的祖先链，能连上就连上、连不上就排除。孤儿很罕见（只在有删除时出现），
  // 所以这里的整日志读取很少。
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
      // 读不出来的孤儿就让它当孤岛，家族照样组装。
    }
  }

  const entries: VersionEntryLike[] = []
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

/** 该会话版本家族里所有存活会话（根 + 全部后代，跨越被删成员，不含 ghost）。 */
async function familySessionIds(ctx: HostContext, sessionId: string): Promise<string[]> {
  const { flat } = await assembleFamily(ctx, sessionId)
  const ids = new Set<string>([sessionId])
  for (const { entry } of flat) {
    if (!entry.ghost)
      ids.add(entry.id)
  }
  return [...ids]
}

/**
 * 分支前停掉这个家族里每一个仍在生成的回合。
 *
 * 编辑必须停掉它所取代的回复——每个聊天 UI 都这么做，放任它继续跑就是为没人会读的
 * 回答烧 token。只取消被编辑的那个会话还不够：版本是独立会话，所以早先启动的兄弟分支
 * 可能还在流式输出，而你正在编辑另一个。那恰恰是既难注意到、又难手动停掉的运行。
 *
 * 家族追不出来时回退到只处理源会话，于是查找失败也仍会停掉最明显的那个，而不是什么都不停。
 */
async function stopFamilyTurns(ctx: HostContext, sessionId: string): Promise<number> {
  let ids: string[]
  try {
    ids = await familySessionIds(ctx, sessionId)
  }
  catch {
    ids = [sessionId]
  }
  let stopped = 0
  for (const id of ids) {
    if (await stopRunningTurn(ctx, id))
      stopped += 1
  }
  return stopped
}

/** 执行一次分支操作（编辑 / 重试）。 */
async function runOperation(ctx: HostContext, operation: MessageOperationLike): Promise<EditSessionResponse> {
  const sourceId = operation.sessionId
  if (operation.stopPrevious === true)
    await stopFamilyTurns(ctx, sourceId)
  return withSourceAgent(ctx, sourceId, async (source: any) => {
    const childId = `session-${crypto.randomUUID()}`
    const inverses: Array<() => void | Promise<void>> = []
    try {
      const record = sessionRecord(source.session)
      const events = record.events
      const plan = planOperation(operation, events)
      const options = agentOptions(events, source.options)
      const versionEffect = plan.version as { effect: { targetTurn: number }, inverse: { sessionId?: string } }
      const attach = await resolveAttachSession(ctx, record, versionEffect.effect.targetTurn)
      if (sessionRecordId(attach) !== record.id) {
        const turn = closedTurns(attach.events).find((candidate: TurnLike) => candidate.turn === versionEffect.effect.targetTurn)
        if (turn === undefined)
          throw new Error('无法在父会话上定位同一回合。')
        plan.boundary = turn.startSeq - 1
        versionEffect.inverse.sessionId = sessionRecordId(attach)
      }
      const child = await createVersionAgent(ctx, attach, childId, plan, options)
      inverses.push(() => child.dispose())
      for (const message of plan.queuedUsers)
        child.agent.followup(message)
      inverses.length = 0
      await attachToParentWorkspace(ctx, sessionRecordId(attach) as string, childId)
      return { sessionId: childId, queuedTurns: [plan.queuedUsers.length] }
    }
    catch (error) {
      try {
        await recoverOperation(inverses)
      }
      catch (recoveryError) {
        throw new AggregateError([error, recoveryError], '版本操作及其恢复均失败。')
      }
      throw error
    }
  })
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

  // 缓存身份，但不要把已释放会话的整份日志留在内存里。
  const entry = { key, live: live === undefined ? undefined : new WeakRef(live), turns, effect, time }
  if (sessionParsedCache.size >= SESSION_CACHE_MAX) {
    const firstKey = sessionParsedCache.keys().next().value
    if (firstKey !== undefined)
      sessionParsedCache.delete(firstKey)
  }
  sessionParsedCache.set(id, entry)
  return entry
}

/** 投影整棵版本树（客户端 ‹ › 环与版本图的数据面）。 */
async function tree(ctx: HostContext, sessionId: string): Promise<{ sessionId: string, versions: VersionLike[] }> {
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

/* -------------------------------------------------------------- 对外面 -- */

/** 请求体必须是 JSON 对象。 */
function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('请求体必须是 JSON 对象。')
  return value as Record<string, unknown>
}

/** sessionId 必须是非空字符串。 */
function sessionIdOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError('sessionId 必须是非空字符串。')
  return value
}

/** 非负安全整数校验。 */
function integerOf(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${label} 必须是非负安全整数。`)
  return value as number
}

/** 解析 POST 体里的 edit / retry 操作。 */
function decodeOperation(value: unknown): MessageOperationLike {
  const record = objectValue(value)
  const sessionId = sessionIdOf(record.sessionId)
  switch (record.action) {
    case 'edit': {
      if (typeof record.text !== 'string' || record.text.trim().length === 0)
        throw new TypeError('text 必须是非空字符串。')
      // 定位轮次的两条路径：DOM 注入只读得到 turn，气泡 props 带 eventSeq + blockIndex。
      const hasTurn = Number.isSafeInteger(record.turn) && (record.turn as number) >= 0
      const hasEventSeq = Number.isSafeInteger(record.eventSeq) && (record.eventSeq as number) >= 0
      if (!hasTurn && !hasEventSeq)
        throw new TypeError('必须提供 turn 或 eventSeq 来定位被编辑的消息。')
      const hasBlockIndex = Number.isSafeInteger(record.blockIndex) && (record.blockIndex as number) >= 0
      return {
        action: 'edit',
        sessionId,
        ...(hasEventSeq ? { eventSeq: integerOf(record.eventSeq, 'eventSeq') } : {}),
        ...(hasBlockIndex ? { blockIndex: integerOf(record.blockIndex, 'blockIndex') } : {}),
        ...(hasTurn ? { turn: integerOf(record.turn, 'turn') } : {}),
        text: record.text,
        stopPrevious: record.stopPrevious === true,
      }
    }
    case 'retry':
      return {
        action: 'retry',
        sessionId,
        turn: integerOf(record.turn, 'turn'),
        stopPrevious: record.stopPrevious === true,
      }
    default:
      throw new TypeError('action 必须是 edit 或 retry。')
  }
}

/** 读版本树（GET /message-tree?sessionId=…）。 */
export async function readTree(ctx: HostContext, sessionId: string): Promise<unknown> {
  return tree(ctx, sessionIdOf(sessionId))
}

/**
 * 执行一次 POST：activate 只清除归档标记（不创建任何东西），其余走分支事务。
 */
export async function applyOperation(ctx: HostContext, body: unknown): Promise<unknown> {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined
  if (record !== undefined && record.action === 'activate')
    return activateVersion(ctx, sessionIdOf(record.sessionId))
  return runOperation(ctx, decodeOperation(body))
}
