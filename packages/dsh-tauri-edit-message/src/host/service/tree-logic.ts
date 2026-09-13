/**
 * host/service/tree-logic.ts — 版本家族树的纯函数（宿主与测试共用）。
 *
 * 逐字移植 dsh-plugin-message-edit 的 lib/tree-logic.js（MIT © SpookySandwich）：
 * 只把 JS 写成 TS，逻辑一行未改。客户端默认不引本文件（DOM 注入路径不需要树），
 * 需要时再按同一套规则复刻。
 */

import type { TurnNode, VersionEntryLike, VersionLike } from '../types'

/**
 * 沿「同一轮次的版本」向上走，停在第一个**不是**该轮编辑的会话。
 * 新的兄弟分支挂在该节点上，于是同一条消息的多次编辑会扇出而不是串成链。
 */
export function attachParentId(
  nodesById: Map<string, { targetTurn?: number, parentSessionId?: string }>,
  sourceId: string,
  targetTurn: number,
): string {
  let id = sourceId
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    seen.add(id)
    const node = nodesById.get(id)
    if (!node)
      return id
    if (node.targetTurn !== targetTurn)
      return id
    if (!node.parentSessionId)
      return id
    id = node.parentSessionId
  }
  return sourceId
}

/**
 * 查看 `sessionId` 时，第 `turn` 条消息的 ‹ › 环。
 *
 * 收集原消息所在会话与该轮的全部版本——包括旧版本把它们串成 A→B→C 而非扇出的情况。
 */
export function ringFor(
  versions: readonly VersionLike[] | undefined,
  sessionId: string | undefined,
  turn: number,
): { alternatives: readonly VersionLike[], index: number } | null {
  if (!versions)
    return null
  const byId = new Map(versions.map(v => [v.sessionId, v]))
  let cursor = byId.get(sessionId as string)
  if (!cursor)
    return null
  while (cursor.parentSessionId && typeof cursor.targetTurn === 'number' && cursor.targetTurn > turn) {
    const parent = byId.get(cursor.parentSessionId)
    if (!parent)
      break
    cursor = parent
  }
  let fork = cursor
  while (fork.parentSessionId && typeof fork.targetTurn === 'number' && fork.targetTurn === turn) {
    const parent = byId.get(fork.parentSessionId)
    if (!parent)
      break
    fork = parent
  }
  const forkId = fork.sessionId
  const walksToFork = (start: VersionLike): boolean => {
    let x: VersionLike | undefined = start
    const seen = new Set<string>()
    while (x && !seen.has(x.sessionId)) {
      seen.add(x.sessionId)
      if (x.sessionId === forkId)
        return true
      if (typeof x.targetTurn !== 'number' || x.targetTurn !== turn)
        return false
      x = x.parentSessionId ? byId.get(x.parentSessionId) : undefined
    }
    return false
  }
  // 被删除（ghost）的版本仍然锚定分叉点、也仍然参与上面的父链行走，但它打不开，
  // 所以不出现在替代列表里：环在幸存者上重新编号。
  const alternatives = versions
    .filter(v => !v.deleted && (v.sessionId === forkId || (v.targetTurn === turn && walksToFork(v))))
    .sort((a, b) => a.createdAt - b.createdAt || String(a.sessionId).localeCompare(String(b.sessionId)))
  if (alternatives.length < 2)
    return null
  const cursorId = cursor.sessionId
  let index = alternatives.findIndex(v => v.sessionId === cursorId)
  if (index === -1)
    index = alternatives.findIndex(v => v.sessionId === sessionId)
  if (index === -1)
    index = 0
  return { alternatives, index }
}

/**
 * `sessionId` 所属家族的根：沿 `parentSessionId` 一直向上走到没有父的会话。
 * 用作「记住的活动分支」的键，因此会话的每个分支共享一个条目。
 */
export function rootOf(versions: readonly VersionLike[] | undefined, sessionId: string | undefined): string | undefined {
  if (!versions || sessionId === undefined)
    return undefined
  const byId = new Map(versions.map(v => [v.sessionId, v]))
  let cursor = byId.get(sessionId)
  if (!cursor)
    return undefined
  const seen = new Set<string>()
  while (cursor.parentSessionId && !seen.has(cursor.sessionId)) {
    seen.add(cursor.sessionId)
    const parent = byId.get(cursor.parentSessionId)
    if (!parent)
      break
    cursor = parent
  }
  return cursor.sessionId
}

/**
 * 从会话自己的事件日志重建祖先链，桥接那些会话已被删除的祖先。
 *
 * 版本的 seed 继承父会话的事件，其中包含父自己的 `message-tree/version` 标记——
 * 并传递性地包含直到根的全部祖先标记（根没有标记）。因此 `markers`（单个会话完整
 * 日志里按 seq 排序的 message-tree/version 事件）就铺开了族谱：最后一条是自己的，
 * 前一条属于父，依此类推；每条标记的 `inverse.sessionId` 指出其所属会话的父。
 * 这些信息能在删除后存活，因为它存在于后代的日志里，而不是祖先的。
 */
export function ancestorChainFromLog(
  parentId: string | undefined,
  markers: readonly Record<string, unknown>[],
): Array<{ sessionId: string, marker?: Record<string, unknown> }> {
  const chain: Array<{ sessionId: string, marker?: Record<string, unknown> }> = []
  const seen = new Set<string>()
  let id: string | undefined | null = parentId
  let at = markers.length - 2 // markers.at(-1) 是自己的
  while (id !== undefined && id !== null && !seen.has(id)) {
    seen.add(id)
    const marker = at >= 0 ? markers[at] : undefined
    chain.push(marker === undefined ? { sessionId: id } : { sessionId: id, marker })
    const data = marker === undefined ? undefined : marker.data as { inverse?: { sessionId?: string } } | undefined
    id = data && data.inverse ? data.inverse.sessionId : undefined
    at -= 1
  }
  return chain
}

/**
 * 从 `rootId` 向下把一族会话摊平，桥接被删除的会话。
 *
 * `entries` 是已知存在的全部节点：存活会话头 + 从后代日志恢复的 ghost 装饰。
 * 边来自 `parentId` 且以原始 id 为键，所以存活的子会话仍挂在已删除的父下；
 * 没有自身条目的 `parentId` 会补一个裸 ghost 条目，于是被删除撕碎的家族仍是一棵树，
 * 破洞处立着墓碑。
 */
export function collectFamily(
  rootId: string,
  entries: readonly VersionEntryLike[],
): Array<{ entry: VersionEntryLike, depth: number }> {
  const byId = new Map<string, VersionEntryLike>()
  for (const entry of entries)
    byId.set(entry.id, entry)
  for (const entry of entries) {
    if (entry.parentId !== undefined && !byId.has(entry.parentId))
      byId.set(entry.parentId, { id: entry.parentId, ghost: true, createdAt: 0 })
  }
  if (!byId.has(rootId))
    byId.set(rootId, { id: rootId, ghost: true, createdAt: 0 })

  const childrenByParent = new Map<string, VersionEntryLike[]>()
  for (const entry of byId.values()) {
    if (entry.parentId === undefined)
      continue
    const list = childrenByParent.get(entry.parentId) ?? []
    list.push(entry)
    childrenByParent.set(entry.parentId, list)
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)))
  }

  const out: Array<{ entry: VersionEntryLike, depth: number }> = []
  const seen = new Set<string>()
  const visit = (id: string, depth: number): void => {
    if (seen.has(id))
      return
    seen.add(id)
    const entry = byId.get(id)
    if (entry === undefined)
      return
    out.push({ entry, depth })
    for (const child of childrenByParent.get(id) ?? [])
      visit(child.id, depth + 1)
  }
  visit(rootId, 0)
  return out
}

/**
 * 把一族的版本投影成「轮次级」分支树。
 *
 * - 根会话的 Turn 1 挂在根会话节点上；
 * - 第 K 轮的兄弟编辑挂在其父的第 K-1 轮（K === 1 时挂根）；
 * - 同一会话里后续轮次挂在该会话里的前驱轮上。
 */
export function buildTurnTree(
  versions: readonly VersionLike[] | undefined,
  currentSessionId: string,
): TurnNode[] {
  if (!versions || versions.length === 0)
    return []
  const byId = new Map(versions.map(v => [v.sessionId, v]))

  // 家族根会话
  let rootVersion = versions.find(v => !v.parentSessionId)
  if (!rootVersion) {
    const rootId = rootOf(versions, currentSessionId) ?? versions[0].sessionId
    rootVersion = byId.get(rootId) ?? versions[0]
  }
  const rootSessionId = rootVersion.sessionId

  const nodes: TurnNode[] = []
  const rootNodeId = `${rootSessionId}#root`
  const nodeMap = new Map<string, TurnNode>()

  const rootNode: TurnNode = {
    id: rootNodeId,
    sessionId: rootSessionId,
    turn: 0,
    isRoot: true,
    time: rootVersion.createdAt ?? 0,
    current: currentSessionId === rootSessionId && (!rootVersion.turns || rootVersion.turns.length === 0),
    onCurrentPath: true,
    deleted: !!rootVersion.deleted,
    archived: !!rootVersion.archived,
  }
  nodes.push(rootNode)
  nodeMap.set(rootNodeId, rootNode)

  function findParentTurnNodeId(v: VersionLike, turn: number): string {
    if (!v.parentSessionId) {
      if (turn === 1)
        return rootNodeId
      return `${v.sessionId}#t${turn - 1}`
    }
    if (turn === v.targetTurn) {
      if (v.targetTurn === 1)
        return rootNodeId
      return `${v.parentSessionId}#t${v.targetTurn - 1}`
    }
    return `${v.sessionId}#t${turn - 1}`
  }

  for (const v of versions) {
    const isCurrentSession = v.sessionId === currentSessionId
    const turns = Array.isArray(v.turns) && v.turns.length > 0 ? v.turns : []

    if (!v.parentSessionId) {
      for (const t of turns) {
        const turnNum = t.turn
        const turnNodeId = `${v.sessionId}#t${turnNum}`
        const node: TurnNode = {
          id: turnNodeId,
          sessionId: v.sessionId,
          turn: turnNum,
          parentId: findParentTurnNodeId(v, turnNum),
          time: t.time ?? v.createdAt,
          text: t.text ?? '',
          current: isCurrentSession,
          onCurrentPath: false,
          deleted: !!v.deleted,
          archived: !!v.archived,
        }
        nodes.push(node)
        nodeMap.set(turnNodeId, node)
      }
      continue
    }

    const targetTurn = typeof v.targetTurn === 'number' ? v.targetTurn : 1
    const ownTurns = turns.filter(t => t.turn >= targetTurn)
    if (ownTurns.length === 0) {
      const turnNodeId = `${v.sessionId}#t${targetTurn}`
      const node: TurnNode = {
        id: turnNodeId,
        sessionId: v.sessionId,
        turn: targetTurn,
        parentId: findParentTurnNodeId(v, targetTurn),
        operation: v.operation ?? 'edit',
        text: v.after ?? v.before ?? '',
        time: v.createdAt ?? 0,
        current: isCurrentSession,
        onCurrentPath: false,
        deleted: !!v.deleted,
        archived: !!v.archived,
      }
      nodes.push(node)
      nodeMap.set(turnNodeId, node)
      continue
    }
    for (const t of ownTurns) {
      const turnNum = t.turn
      const turnNodeId = `${v.sessionId}#t${turnNum}`
      const isForkTurn = turnNum === targetTurn
      const node: TurnNode = {
        id: turnNodeId,
        sessionId: v.sessionId,
        turn: turnNum,
        parentId: findParentTurnNodeId(v, turnNum),
        ...(isForkTurn && v.operation ? { operation: v.operation } : {}),
        text: t.text ?? (isForkTurn ? (v.after ?? v.before ?? '') : ''),
        time: t.time ?? v.createdAt,
        current: isCurrentSession,
        onCurrentPath: false,
        deleted: !!v.deleted,
        archived: !!v.archived,
      }
      nodes.push(node)
      nodeMap.set(turnNodeId, node)
    }
  }

  // 悬空的 parentId 一律指向根节点
  const allIds = new Set(nodes.map(n => n.id))
  for (const n of nodes) {
    if (n.parentId && !allIds.has(n.parentId))
      n.parentId = rootNodeId
  }

  // 活动路径：从当前会话最新一轮沿 parentId 向上走
  const activePathIds = new Set<string>()
  let latestNode: TurnNode | null = null
  for (const n of nodes) {
    if (n.sessionId === currentSessionId) {
      if (!latestNode || (n.turn ?? 0) >= (latestNode.turn ?? 0))
        latestNode = n
    }
  }
  let pathCursor: TurnNode | null = latestNode || nodes[0]
  const seenPath = new Set<string>()
  while (pathCursor && !seenPath.has(pathCursor.id)) {
    seenPath.add(pathCursor.id)
    activePathIds.add(pathCursor.id)
    pathCursor = pathCursor.parentId ? nodeMap.get(pathCursor.parentId) ?? null : null
  }
  activePathIds.add(rootNodeId)

  for (const n of nodes)
    n.onCurrentPath = activePathIds.has(n.id)

  return nodes
}
