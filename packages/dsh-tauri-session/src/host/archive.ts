/**
 * archive.ts — 归档业务域：读取归档列表、归档/取消归档、旧版 v1 归档迁移，
 * 以及「彻底删除归档会话」的删除事务。
 *
 * 删除事务一致性（重点修复）：
 *   事务顺序 = 预检（成员 + 宿主面，变更前全部完成）→ 物理删除（失败即中止，
 *   注册表未动可整体重试）→ 内存移除（best-effort，只记日志不中断）→
 *   注册表事务（工作区记账 + 归档集合在同一个 enqueueOperation 内原子完成）。
 *   任意物理失败都会在触碰注册表之前中止，绝不留下「数据已删但归档仍列」的幽灵，
 *   也不允许并发删除在记账与归档集合之间交错。
 */

import type {
  RegistryArchiveSurface,
} from './registry.js'
import type { ArchivedListPayload, ArchiveDocument, HostContext } from './types.js'
import { rmSync } from 'node:fs'
import { join } from 'pathe'
import { SESSION_PLUGIN_NAME } from '../shared/constants.js'
import { SESSION_ARCHIVE_FILE } from './constants.js'
import { archiveHooks } from './hooks.js'
import {
  registryArchiveSurface,
  removeArchivedSessionsFromRegistry,
  removeLiveSessions,
  requireArchivedMember,
  requireArchiveSession,
  requireDeletionSurfaces,
  restoreSessionWorkspaceAccounting,
} from './registry.js'
import {
  findSession,
  removeSessionDataDir,
  sessionCwd,
} from './session-files.js'
import { loadArchive, saveArchive, sessionStateDir } from './storage.js'

/** 组装 GET /archived 的载荷：宿主归档集合 id + 每个会话的创建元数据（读 host session header）。 */
export function buildArchivedPayload(ctx: HostContext): ArchivedListPayload {
  const registry = ctx.workspaceRegistry as { archivedSessionIds?: readonly string[] } | undefined
  const archivedSessionIds: string[] = []
  const meta: ArchivedListPayload['meta'] = {}
  for (const sessionId of registry?.archivedSessionIds ?? []) {
    const session = findSession(ctx, sessionId)
    if (!session)
      continue
    archivedSessionIds.push(sessionId)
    const cwd = sessionCwd(session)
    meta[sessionId] = {
      createdAt: session?.header?.createdAt,
      cwd,
      ...(session?.displayTitle ? { title: session.displayTitle } : session?.title ? { title: session.title } : {}),
    }
  }
  return { archivedSessionIds, meta }
}

/** 归档一个会话（宿主归档集合，幂等：已归档则无操作）。 */
export async function archiveSession(ctx: HostContext, body: Record<string, unknown>): Promise<ArchivedListPayload> {
  const sessionId = String(body.sessionId ?? '')
  if (!sessionId)
    throw new Error('缺少 sessionId')
  await requireArchiveSession(ctx)(sessionId)
  void archiveHooks.callHook('archive:added', sessionId)
  return buildArchivedPayload(ctx)
}

/** 归档一组会话（「归档工作区」：一次调用归档该组全部会话）。 */
export async function archiveWorkspace(ctx: HostContext, body: Record<string, unknown>): Promise<ArchivedListPayload> {
  const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds.map(String) : []
  if (sessionIds.length === 0)
    throw new Error('缺少 sessionIds')
  const archiveSession = requireArchiveSession(ctx)
  for (const sessionId of sessionIds) {
    await archiveSession(sessionId)
    void archiveHooks.callHook('archive:added', sessionId)
  }
  return buildArchivedPayload(ctx)
}

/** 取消归档：移除归档标记，并修复历史数据缺失的工作区归属槽位。 */
export async function unarchiveSession(ctx: HostContext, body: Record<string, unknown>): Promise<{ ok: true }> {
  const sessionId = String(body.sessionId ?? '')
  if (!sessionId)
    throw new Error('缺少 sessionId')
  const registry = registryArchiveSurface(ctx) as Required<Pick<RegistryArchiveSurface, 'enqueueOperation' | 'requireState' | 'setState'>>
  await registry.enqueueOperation(async () => {
    await restoreSessionWorkspaceAccounting(ctx, sessionId)
    const state = registry.requireState()
    const archived = [...(state.archivedSessionIds ?? [])]
    const next = archived.filter(id => id !== sessionId)
    if (next.length !== archived.length)
      await registry.setState({ ...state, archivedSessionIds: next })
  })
  void archiveHooks.callHook('archive:restored', sessionId)
  return { ok: true as const }
}

/**
 * 一次性迁移旧版插件自持归档（`$DSH_HOME/dsh-tauri-session/archive.json`）到宿主
 * 归档集合。迁移成功的记录从旧文件中移除；仍失败的（如会话已不存在）保留在旧
 * 文件中，下次启动幂等重试 —— 绝不因单次失败丢弃用户数据。
 */
export async function migrateLegacyArchive(ctx: HostContext, dshHome: string): Promise<void> {
  const legacy = await loadArchive(dshHome)
  const sessionIds = Object.keys(legacy)
  if (sessionIds.length === 0)
    return
  let migrated = 0
  const failed: string[] = []
  let archiveSession: ((sessionId: string) => Promise<void>) | undefined
  try {
    archiveSession = requireArchiveSession(ctx)
  }
  catch {
    // 宿主不提供 archiveSession 时保留全部旧记录，下次启动重试，绝不误删。
    failed.push(...sessionIds)
  }
  if (archiveSession) {
    for (const sessionId of sessionIds) {
      try {
        await archiveSession(sessionId)
        migrated += 1
      }
      catch {
        failed.push(sessionId)
      }
    }
  }
  try {
    if (failed.length === 0) {
      rmSync(join(sessionStateDir(dshHome), SESSION_ARCHIVE_FILE), { force: true })
    }
    else {
      // 只保留未迁移成功的记录，避免下次启动重复迁移已成功的会话。
      const remaining: ArchiveDocument = {}
      for (const sessionId of failed)
        remaining[sessionId] = legacy[sessionId]
      await saveArchive(remaining, dshHome)
    }
  }
  catch {
    // 旧文件整理失败不影响新机制（下次启动会再尝试迁移）。
  }
  ctx.logger?.info?.(`[${SESSION_PLUGIN_NAME}] migrated ${migrated}/${sessionIds.length} legacy archived session(s) into the host registry`)
}

/**
 * 彻底删除一批归档会话——删除事务的核心实现（见文件头的事务顺序）。
 * 所有 id 共用一次预检、一次注册表事务，杜绝逐会话部分删除。
 */
async function permanentlyDeleteSessions(ctx: HostContext, dshHome: string, rawIds: readonly string[]): Promise<{ ok: true }> {
  const ids = [...new Set(rawIds.map(String).filter(Boolean))]
  if (ids.length === 0)
    throw new Error('缺少 sessionIds')

  // 1) 预检（变更前一次性完成）：全部 id 必须是归档成员，且删除所需宿主面齐全。
  for (const sessionId of ids)
    requireArchivedMember(ctx, sessionId)
  const { sessions } = requireDeletionSurfaces(ctx, ids)

  // 2) 物理删除：任一目录删除抛出异常即在触碰注册表前中止，状态保持可整体重试。
  let removed = 0
  for (const sessionId of ids) {
    try {
      if (removeSessionDataDir(dshHome, sessionId))
        removed += 1
    }
    catch (error) {
      throw new Error(`删除会话数据失败：${sessionId}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  // 3) 内存移除：best-effort，失败仅记日志；注册表事务照常完成，刷新后内存自愈。
  const liveFailures = removeLiveSessions(sessions, ids)
  for (const sessionId of liveFailures) {
    ctx.logger?.warn?.(`[${SESSION_PLUGIN_NAME}] 会话 '${sessionId}' 无法从内存移除，刷新后消失`)
  }

  // 4) 注册表事务：工作区记账移除 + 归档集合移除，在同一个串行事务内原子完成。
  await removeArchivedSessionsFromRegistry(ctx, ids)
  void archiveHooks.callHook('archive:deleted', ids)

  ctx.logger?.info?.(`[${SESSION_PLUGIN_NAME}] permanently deleted ${ids.length} archived session(s) (data removed: ${removed})`)
  return { ok: true as const }
}

/** 彻底删除一个归档会话（成员校验 + 物理删除 + 记账更新）。 */
export async function permanentlyDeleteSession(ctx: HostContext, dshHome: string, body: Record<string, unknown>): Promise<{ ok: true }> {
  const sessionId = String(body.sessionId ?? '')
  if (!sessionId)
    throw new Error('缺少 sessionId')
  return permanentlyDeleteSessions(ctx, dshHome, [sessionId])
}

/** 彻底删除指定归档会话（先物理删除全部，再批量更新记账）。 */
export async function permanentlyDeleteSelected(ctx: HostContext, dshHome: string, body: Record<string, unknown>): Promise<{ ok: true }> {
  const rawIds = body.sessionIds
  if (!Array.isArray(rawIds) || rawIds.length === 0)
    throw new Error('缺少 sessionIds')
  return permanentlyDeleteSessions(ctx, dshHome, rawIds as string[])
}

/** 彻底删除全部已归档会话（先物理删除全部，再批量更新记账）。 */
export async function permanentlyDeleteAll(ctx: HostContext, dshHome: string): Promise<{ ok: true }> {
  const registry = ctx.workspaceRegistry as { archivedSessionIds?: readonly string[] } | undefined
  const ids = [...(registry?.archivedSessionIds ?? [])]
  return permanentlyDeleteSessions(ctx, dshHome, ids)
}
