import type { ArchiveRegistrySurface, ArchiveTableSurface, SessionLike, WorkspaceEntryLike } from '../config/runtime.types'
import type { ArchiveAccounting, ArchivedListPayload } from './ledger.types'
import { defineService } from 'dsh-tauri'
import { difference, keyBy, uniq } from 'lodash-es'
import { getCurrentHostInstance } from '../config/runtime'
import { sessionStore } from './session-store'

export const ledger = defineService({
  /**
   * 宿主归档集合的原始 id 快照（含尚未解析到会话对象的残留 id）。
   * 同时断言变更面齐全 —— 删除事务的预检必须在任何破坏性动作之前完成。
   */
  list(): string[] {
    const registry = getCurrentHostInstance().workspaceRegistry
    requireWritableRegistry(registry)
    requireTable(registry)
    return [...(registry.archivedSessionIds ?? [])]
  },

  /** 归档集合的公开投影：id + 每个会话的创建元数据。 */
  load(): ArchivedListPayload {
    const archivedSessionIds: string[] = []
    const meta: ArchivedListPayload['meta'] = {}
    for (const sessionId of getCurrentHostInstance().workspaceRegistry.archivedSessionIds ?? []) {
      const session = sessionStore.load(sessionId)
      if (session === null)
        continue
      archivedSessionIds.push(sessionId)
      const title = session.displayTitle ?? session.title
      meta[sessionId] = {
        createdAt: session.header?.createdAt,
        cwd: cwdOf(session),
        ...(title === undefined ? {} : { title }),
      }
    }
    return { archivedSessionIds, meta }
  },

  /** 写入归档集合（宿主 archiveSession，幂等）；宿主未暴露时抛错，绝不静默降级。 */
  async save(sessionId: string): Promise<void> {
    const registry = getCurrentHostInstance().workspaceRegistry
    const archiveSession = registry.archiveSession
    if (typeof archiveSession !== 'function')
      throw new Error('宿主 workspaceRegistry 未提供 archiveSession（宿主版本不兼容）')
    await archiveSession.call(registry, sessionId)
  },

  /**
   * 在**同一个**串行事务内改写归档集合与工作区记账，杜绝并发交错产生的半删除状态。
   * `accounting` 为 `detach` 时摘除记账（彻底删除），`attach` 时修复缺失槽位（取消归档）。
   */
  async remove(sessionIds: readonly string[], accounting: ArchiveAccounting = 'detach'): Promise<void> {
    const registry = requireWritableRegistry(getCurrentHostInstance().workspaceRegistry)
    const ids = uniq(sessionIds)
    await registry.enqueueOperation(async () => {
      if (accounting === 'attach')
        await restoreWorkspaceAccounting(registry, ids)
      else
        await detachWorkspaceAccounting(registry, ids)
      const state = registry.requireState()
      const archived = state.archivedSessionIds ?? []
      const next = difference(archived, ids)
      if (next.length !== archived.length)
        await registry.setState({ ...state, archivedSessionIds: next })
    })
  },
})

// --- internal ---

function cwdOf(session: SessionLike | null): string | undefined {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

function requireWritableRegistry(registry: ArchiveRegistrySurface): Required<Pick<ArchiveRegistrySurface, 'enqueueOperation' | 'requireState' | 'setState'>> & ArchiveRegistrySurface {
  if (typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function' || typeof registry.setState !== 'function')
    throw new Error('宿主 workspaceRegistry 未暴露归档集合的变更接口（宿主版本不兼容）')
  return registry as Required<Pick<ArchiveRegistrySurface, 'enqueueOperation' | 'requireState' | 'setState'>> & ArchiveRegistrySurface
}

function requireTable(registry: ArchiveRegistrySurface): ArchiveTableSurface {
  const table = registry.requireTable?.()
  if (!table)
    throw new Error('宿主 workspaceRegistry 未暴露工作区会话记账接口（宿主版本不兼容）')
  return table
}

async function detachWorkspaceAccounting(registry: ArchiveRegistrySurface, sessionIds: readonly string[]): Promise<void> {
  const table = requireTable(registry)
  for (const [workspaceId, record] of table.entries()) {
    const current = record.sessionIds ?? []
    const next = difference(current, sessionIds)
    if (next.length !== current.length)
      await table.update(workspaceId, value => ({ ...value, sessionIds: next }))
  }
}

/**
 * 修复历史删除尝试抹掉的工作区归属槽位：正常归档的会话已有槽位，这里是空操作；
 * 受损数据按会话 header.cwd 与工作区 path 匹配后补回。
 */
async function restoreWorkspaceAccounting(registry: ArchiveRegistrySurface, sessionIds: readonly string[]): Promise<void> {
  const table = registry.requireTable?.()
  const workspaces = registry.list?.()
  if (!table || !workspaces)
    return
  const byPath = keyBy<WorkspaceEntryLike>(workspaces, 'path')
  for (const sessionId of sessionIds) {
    const cwd = cwdOf(sessionStore.load(sessionId))
    const workspace = cwd ? byPath[cwd] : undefined
    if (!workspace || workspace.sessionIds?.includes(sessionId))
      continue
    await table.update(workspace.id, current => ({ ...current, sessionIds: [...(current.sessionIds ?? []), sessionId] }))
  }
}
