/**
 * archive-sort.ts — 归档列表的分组与排序纯函数。
 *
 * 需求规则：
 *   - 排序方式（更新时间 / 创建时间 / 按字母排序）同时影响「组」与「组内聊天」
 *     （组与聊天两级都排序）；
 *   - 组的排序键取自其成员按当前排序方式聚合出的值（更新时间取组内最新、
 *     创建时间取组内最早、字母取组内标题首位）。
 */
import type { ArchiveRow, ArchiveSort } from '../types'

/** 组内聊天排序后的行。 */
export interface ArchiveGroupRow {
  /** workspaceId，或未分组桶的 'ungrouped'。 */
  id: string
  /** 工作区标题；未分组桶传 ''（由组件填当前语言的「未分组」文案）。 */
  title: string
  rows: ArchiveRow[]
}

/** 单个聊天的排序键（按排序方式）。 */
export function rowSortValue(row: ArchiveRow, sort: ArchiveSort): number | string {
  if (sort === 'title')
    return row.title.toLowerCase()
  if (sort === 'createdAt')
    return row.createdAt ?? 0
  return row.updatedAt ?? 0
}

/** 按当前排序方式比较两个聊天（时间降序、字母升序）。 */
function compareRows(a: ArchiveRow, b: ArchiveRow, sort: ArchiveSort): number {
  const av = rowSortValue(a, sort)
  const bv = rowSortValue(b, sort)
  if (sort === 'title') {
    const as = typeof av === 'string' ? av : ''
    const bs = typeof bv === 'string' ? bv : ''
    return as.localeCompare(bs)
  }
  return (bv as number) - (av as number)
}

/** 组的聚合排序键（按当前排序方式从成员聚合出）。 */
function groupSortValue(rows: ArchiveRow[], sort: ArchiveSort): number | string {
  if (sort === 'title')
    return rows.reduce<string>((min, row) => (row.title.toLowerCase() < min ? row.title.toLowerCase() : min), rows[0]?.title.toLowerCase() ?? '')
  if (sort === 'createdAt')
    return rows.reduce<number>((min, row) => Math.min(min, row.createdAt ?? 0), Number.MAX_SAFE_INTEGER)
  return rows.reduce<number>((max, row) => Math.max(max, row.updatedAt ?? 0), 0)
}

/**
 * 把归档行按工作区分组并按排序方式排好（组与组内聊天两级都按排序方式排）。
 * @param rows - 合并后的归档行（未过滤）。
 * @param sort - 排序方式（影响组内与组排名）。
 * @param ungroupedLabel - 「未分组」桶的标题。
 * @returns 有序的组列表（组内已按排序方式排好）。
 */
export function groupArchive(rows: ArchiveRow[], sort: ArchiveSort, ungroupedLabel: string): ArchiveGroupRow[] {
  const buckets = new Map<string, ArchiveRow[]>()
  for (const row of rows) {
    const key = row.workspaceId ?? 'ungrouped'
    const bucket = buckets.get(key)
    if (bucket)
      bucket.push(row)
    else
      buckets.set(key, [row])
  }

  const groups: ArchiveGroupRow[] = []
  for (const [id, memberRows] of buckets) {
    const sortedRows = [...memberRows].sort((a, b) => compareRows(a, b, sort))
    const workspace = id === 'ungrouped' ? undefined : rows.find(r => r.workspaceId === id)
    groups.push({
      id,
      title: workspace?.workspaceTitle ?? (id === 'ungrouped' ? ungroupedLabel : ''),
      rows: sortedRows,
    })
  }

  // 组按成员聚合值排（时间降序、字母升序），与组内聊天同一排序口径。
  groups.sort((a, b) => {
    const av = groupSortValue(a.rows, sort)
    const bv = groupSortValue(b.rows, sort)
    if (sort === 'title') {
      const as = typeof av === 'string' ? av : ''
      const bs = typeof bv === 'string' ? bv : ''
      return as.localeCompare(bs)
    }
    return (bv as number) - (av as number)
  })

  return groups
}
