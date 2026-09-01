/**
 * store.ts — 归档页面的共享客户端状态与 RPC（/api/dsh-session/*）。
 *
 * store 保存「原始归档载荷」（archivedSessionIds + meta）与页面筛选状态；
 * 每个归档会话的业务字段（标题、更新时间、工作区组）由组件合并
 * ctx.sessions / ctx.workspaces 的运行时快照得到，这里不复制那份数据。
 *
 * unarchive/delete/clear 走宿主注册表内部状态机（官方没有对应 unary 动作），
 * 不会产生官方 changed frame —— 因此这些变更成功后调用方必须传入 resync
 * （ctx.workspaces.manager.refresh）重新拉取归档镜像，否则列表原地不动。
 */
import type { ArchiveSort, ArchiveUiState } from '../types'
import { createExternalStore } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import {
  fetchArchived,
  postArchive,
  postArchiveWorkspace,
  postClear,
  postDelete,
  postDeleteWorkspace,
  postUnarchive,
} from '../apis'

export type { ArchivedListPayload, ArchiveUiState } from '../types'

/** 从 unknown 错误里取可展示文本（Error 取 message，其余字符串化）。 */
function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 全局唯一共享状态源（模块级单例）。 */
export const archiveStore = createExternalStore<ArchiveUiState>({
  archived: { archivedSessionIds: [], meta: {} },
  sort: 'updatedAt',
  query: '',
  workspaceId: 'all',
  loading: false,
  pending: false,
  error: '',
  suppressedSessionIds: [],
  titleById: {},
})

/** 组件内订阅归档 UI 状态（uSES）。 */
export function useArchiveUi(): ArchiveUiState {
  return useSyncExternalStore(archiveStore.subscribe, archiveStore.getSnapshot)
}

/** 归档页排序方式（更新时间 / 创建时间 / 标题）。 */
export function setSort(sort: ArchiveSort): void {
  archiveStore.set(state => ({ ...state, sort }))
}

/** 归档页搜索关键字。 */
export function setQuery(query: string): void {
  archiveStore.set(state => ({ ...state, query }))
}

/** 归档页项目筛选（'all' 显示全部组）。 */
export function setWorkspaceFilter(workspaceId: string): void {
  archiveStore.set(state => ({ ...state, workspaceId }))
}

/** 归档刷新代数：只允许最新一次刷新的响应写回 store（过期响应整体丢弃）。 */
let refreshGeneration = 0

/**
 * 拉取归档载荷并写入 store。
 *
 * 刷新成功后清空抑制标记：抑制只服务于「变更 → 刷新」窗口内的幽灵行
 * （宿主归档集合在变更后短暂含过期 id）。刷新成功即载荷权威，若保留抑制，
 * 取消归档后再归档的会话会被旧标记永久过滤出归档页（#235）。
 *
 * 并发保护：每次调用推进代数，只有仍是最新代数的响应才写回 —— 否则慢的旧
 * 响应会覆盖新数据，或把刚写入的抑制标记清掉（幽灵行提前闪现）。
 */
export async function refreshArchived(): Promise<void> {
  const generation = ++refreshGeneration
  archiveStore.set(state => ({ ...state, loading: true, error: '' }))
  try {
    const archived = await fetchArchived()
    if (generation !== refreshGeneration)
      return
    archiveStore.set(state => ({ ...state, archived, loading: false, suppressedSessionIds: [] }))
  }
  catch (error) {
    if (generation !== refreshGeneration)
      return
    archiveStore.set(state => ({ ...state, loading: false, error: errMessage(error) }))
  }
}

/**
 * 包裹一个破坏性/恢复变更：置 pending（驱动禁用 + loading toast），成功后并行
 * 刷新归档载荷与工作区归档镜像，失败写入 error。返回是否成功。
 */
async function runMutation(mutate: () => Promise<unknown>, resync?: () => Promise<void>, sessionIds: readonly string[] = []): Promise<boolean> {
  archiveStore.set(state => ({ ...state, pending: true, error: '' }))
  try {
    await mutate()
    if (sessionIds.length > 0) {
      archiveStore.set(state => ({
        ...state,
        suppressedSessionIds: [...state.suppressedSessionIds, ...sessionIds.filter(sessionId => !state.suppressedSessionIds.includes(sessionId))],
      }))
    }
    await Promise.all([
      refreshArchived(),
      resync ? Promise.race([resync(), new Promise<void>(resolve => setTimeout(resolve, 2_000))]) : Promise.resolve(),
    ])
    return true
  }
  catch (error) {
    archiveStore.set(state => ({ ...state, error: errMessage(error) }))
    return false
  }
  finally {
    archiveStore.set(state => ({ ...state, pending: false }))
  }
}

/** 归档一个会话并刷新。 */
export async function archiveSession(sessionId: string, workspaceId?: string, beforeSessionId?: string): Promise<void> {
  archiveStore.set(state => ({
    ...state,
    suppressedSessionIds: state.suppressedSessionIds.filter(id => id !== sessionId),
  }))
  await runMutation(() => postArchive(sessionId, workspaceId, beforeSessionId))
}

/** 归档整个工作区并刷新。 */
export async function archiveWorkspace(workspaceId: string, sessionIds: string[]): Promise<void> {
  await runMutation(() => postArchiveWorkspace(workspaceId, sessionIds))
}

/** 取消归档并刷新（resync 重新拉取官方归档镜像）。返回是否成功。 */
export function unarchiveSession(sessionId: string, resync?: () => Promise<void>): Promise<boolean> {
  return runMutation(() => postUnarchive(sessionId), resync, [sessionId])
}

/** 彻底删除单个归档会话并刷新。返回是否成功。 */
export function deleteSession(sessionId: string, resync?: () => Promise<void>): Promise<boolean> {
  return runMutation(() => postDelete(sessionId), resync, [sessionId])
}

/** 彻底删除全部归档会话并刷新。返回是否成功。 */
export function clearArchive(resync?: () => Promise<void>): Promise<boolean> {
  const sessionIds = [...archiveStore.getSnapshot().archived.archivedSessionIds]
  return runMutation(() => postClear(), resync, sessionIds)
}

/** 彻底删除项目内归档会话并刷新。返回是否成功。 */
export function deleteWorkspaceSessions(sessionIds: readonly string[], resync?: () => Promise<void>): Promise<boolean> {
  return runMutation(() => postDeleteWorkspace(sessionIds), resync, sessionIds)
}
