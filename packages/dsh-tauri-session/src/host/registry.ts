/**
 * registry.ts — 宿主归档集合的状态机面。
 *
 * 宿主公开 API 只有 `archiveSession`（没有 unarchive），而取消归档是插件的核心
 * 功能，因此这里显式依赖注册表内部方法：`enqueueOperation`（串行化读改写）、
 * `requireState`（当前持久化状态）、`setState`（写回并发布）。三者任一缺失
 * （宿主升级改内部结构）即报错，绝不静默降级。
 *
 * 删除事务一致性（重点）：
 *   - 工作区记账移除 + 归档集合移除必须在**同一个** enqueueOperation 事务内完成
 *     （removeArchivedSessionsFromRegistry），避免并发删除交错产生「记账已更新但
 *     归档集合残留」的半删除状态；
 *   - 删除前的成员校验与宿主面校验（requireDeletionSurfaces）发生在任何变更之前，
 *     保证失败可整体重试。
 */

import type { HostContext, SessionLike } from './types.js'
import { findSession, sessionCwd } from './session-files.js'

/** 宿主会话 store 的删除所需表面（桌面壳补丁暴露 remove(id)）。 */
interface SessionStoreSurface {
  get?: (id: string) => SessionLike | undefined
  remove?: (id: string) => boolean
}

/** 宿主 WorkspaceRegistry 的归档集合内部面。 */
export interface RegistryArchiveSurface {
  enqueueOperation?: (fn: () => Promise<void>) => Promise<void>
  requireState?: () => { archivedSessionIds?: readonly string[] }
  requireTable?: () => {
    entries: () => Iterable<[string, { sessionIds?: readonly string[] }]>
    update: (id: string, update: (record: { sessionIds?: readonly string[] }) => { sessionIds: string[] }) => Promise<void>
  }
  setState?: (state: unknown) => Promise<void>
}

export function registryArchiveSurface(ctx: HostContext): RegistryArchiveSurface {
  const registry = ctx.workspaceRegistry as unknown as RegistryArchiveSurface | undefined
  if (!registry || typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function' || typeof registry.setState !== 'function')
    throw new Error('宿主 workspaceRegistry 未暴露归档集合的变更接口（宿主版本不兼容）')
  return registry
}

/** 归档所需方法缺失时报错，绝不静默跳过（否则迁移会误删旧记录）。 */
export function requireArchiveSession(ctx: HostContext): (sessionId: string) => Promise<void> {
  const archiveSession = ctx.workspaceRegistry?.archiveSession
  if (typeof archiveSession !== 'function')
    throw new Error('宿主 workspaceRegistry 未提供 archiveSession（宿主版本不兼容）')
  return archiveSession.bind(ctx.workspaceRegistry) as (sessionId: string) => Promise<void>
}

/** 串行化地改写宿主归档集合（unarchive / 清空共用）。 */
export async function updateRegistryArchiveSet(ctx: HostContext, update: (ids: string[]) => string[]): Promise<void> {
  const registry = registryArchiveSurface(ctx)
  await registry.enqueueOperation!(async () => {
    const state = registry.requireState!()
    const archived = [...(state.archivedSessionIds ?? [])]
    const next = update(archived)
    if (next.length === archived.length && next.every((id, index) => id === archived[index]))
      return
    await registry.setState!({ ...state, archivedSessionIds: next })
  })
}

/** Remove a session from every workspace accounting slot before physical deletion. */
async function removeSessionFromWorkspaceAccounting(
  registry: RegistryArchiveSurface,
  sessionIds: readonly string[],
): Promise<void> {
  const table = registry.requireTable?.()
  if (!table)
    throw new Error('宿主 workspaceRegistry 未暴露工作区会话记账接口（宿主版本不兼容）')
  const ids = new Set(sessionIds)
  for (const [workspaceId, record] of table.entries()) {
    const next = (record.sessionIds ?? []).filter(id => !ids.has(id))
    if (next.length !== (record.sessionIds ?? []).length)
      await table.update(workspaceId, current => ({ ...current, sessionIds: next }))
  }
}

/**
 * 在**一个**串行事务里完成归档会话的注册表移除：工作区会话记账槽位 + 归档集合。
 * 两个写点共用同一 enqueueOperation，使它们相对其他注册表操作原子，杜绝并发删除
 * 交错导致的半删除状态。
 */
export async function removeArchivedSessionsFromRegistry(ctx: HostContext, sessionIds: readonly string[]): Promise<void> {
  const registry = registryArchiveSurface(ctx)
  const ids = new Set(sessionIds)
  await registry.enqueueOperation!(async () => {
    await removeSessionFromWorkspaceAccounting(registry, [...ids])
    const state = registry.requireState!()
    const archived = [...(state.archivedSessionIds ?? [])]
    const next = archived.filter(id => !ids.has(id))
    if (next.length !== archived.length)
      await registry.setState!({ ...state, archivedSessionIds: next })
  })
}

/**
 * Restore the accounting slot when an older delete-all attempt removed it.
 * Normal archives already have the slot and this is a no-op; damaged historical
 * data is repaired from the session header cwd and the matching workspace path.
 */
export async function restoreSessionWorkspaceAccounting(ctx: HostContext, sessionId: string): Promise<void> {
  const registry = registryArchiveSurface(ctx)
  const table = registry.requireTable?.()
  const session = findSession(ctx, sessionId)
  const cwd = sessionCwd(session)
  if (!table || !cwd || typeof ctx.workspaceRegistry?.list !== 'function')
    return
  const workspace = (ctx.workspaceRegistry.list() as Array<{ id: string, path?: string, sessionIds?: readonly string[] }>).find(item => item.path === cwd)
  if (!workspace || workspace.sessionIds?.includes(sessionId))
    return
  await table.update(workspace.id, current => ({ ...current, sessionIds: [...(current.sessionIds ?? []), sessionId] }))
}

/** 会话 id 是否为归档集合成员（删除的授权边界）。 */
export function requireArchivedMember(ctx: HostContext, sessionId: string): void {
  const registry = ctx.workspaceRegistry as { archivedSessionIds?: readonly string[] } | undefined
  if (!registry?.archivedSessionIds?.includes(sessionId))
    throw new Error(`会话 '${sessionId}' 不在归档集合中，拒绝删除`)
}

/** 验证删除所需宿主面齐全；缺失时在变更前报错，保证可重试。 */
export function requireDeletionSurfaces(ctx: HostContext, sessionIds: readonly string[]): { sessions: SessionStoreSurface | undefined } {
  registryArchiveSurface(ctx)
  const registry = ctx.workspaceRegistry as unknown as RegistryArchiveSurface | undefined
  if (!registry?.requireTable)
    throw new Error('宿主 workspaceRegistry 未暴露工作区会话记账接口（宿主版本不兼容）')
  const sessions = ctx.sessions as SessionStoreSurface | undefined
  for (const sessionId of sessionIds) {
    if (sessions?.get?.(sessionId) && !sessions.remove)
      throw new Error('宿主未提供 SessionStore.remove，请先更新桌面壳')
  }
  return { sessions }
}

/**
 * 从内存会话 store 移除（best-effort）。返回无法移除的会话 id 列表，由调用方
 * 记录日志后继续——数据与注册表的一致性优先于内存瞬时状态，刷新后即自愈。
 */
export function removeLiveSessions(sessions: SessionStoreSurface | undefined, sessionIds: readonly string[]): string[] {
  const failed: string[] = []
  for (const sessionId of sessionIds) {
    if (sessions?.get?.(sessionId) && !sessions.remove?.(sessionId))
      failed.push(sessionId)
  }
  return failed
}
