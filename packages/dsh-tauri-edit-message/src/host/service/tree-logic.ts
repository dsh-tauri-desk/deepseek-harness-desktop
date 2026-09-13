import type { VersionEntryLike } from '../types'

/**
 * host/service/tree-logic.ts — 版本家族树的纯函数（只读投影用）。
 *
 * 逐字移植 dsh-plugin-message-edit 的 lib/tree-logic.js（MIT © SpookySandwich）：
 * 只做 TS 化，逻辑未改。边界解析（编辑主路径）**不需要**这些函数，它们只服务
 * `readTree` 的家族桥接与版本图。
 */

/**
 * 从会话自己的事件日志重建祖先链，桥接那些会话已被删除的祖先。
 *
 * 版本的 seed 继承父会话的事件，其中包含父自己的版本标记——并传递性地包含直到根的
 * 全部祖先标记（根没有标记）。因此 `markers`（单个会话完整日志里按 seq 排序的
 * message-tree/version 事件）就铺开了族谱：最后一条是自己的，前一条属于父，
 * 依此类推；每条标记的 `inverse.sessionId` 指出其所属会话的父。
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
 * 从 `rootId` 向下把一族会话摊平，桥接被删除的会话（ghost 墓碑）。
 *
 * `entries` 是已知存在的全部节点：存活会话头 + 从后代日志恢复的 ghost 装饰。
 * 边来自 `parentId` 且以原始 id 为键，所以存活的子会话仍挂在已删除的父下；
 * 没有自身条目的 `parentId` 会补一个裸 ghost 条目。
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
