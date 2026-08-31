/**
 * dsh-tauri-session 宿主侧（node half）：「已归档聊天」的管理接口。
 *
 * 归档语义（v2，与官方机制对齐）：
 *   官方工作区浏览器会话行菜单自带「归档」动作，写入宿主 WorkspaceRegistry 的
 *   归档集合（`archivedSessionIds`，持久化、隐藏于所有分组界面、不动工作区记账，
 *   取消归档自动恢复原组原位）。因此本插件不再维护自有的 `archive.json`，
 *   而是直接读写宿主归档集合：
 *     - `GET  /archived`        读宿主归档集合 + 会话头元数据；
 *     - `POST /archive`         归档单个会话（宿主 `archiveSession`）；
 *     - `POST /archive-workspace` 归档一组会话（插件 UI「归档工作区」）；
 *     - `POST /unarchive`       从宿主归档集合移除（宿主无公开 unarchive，
 *                               走注册表内部状态机，见 `updateRegistryArchiveSet`）；
 *     - `POST /delete`          彻底删除单个归档会话（归档集合移除 + 物理删除会话数据）；
 *     - `POST /clear`           彻底删除全部已归档会话（同上，批量）。
 *   插件初始化时把旧版自持 `archive.json` 的记录一次性迁入宿主集合后删除旧文件。
 */

import type {
  ArchivedListPayload,
  ArchiveDocument,
  HostContext,
  PluginConfig,
  SessionLike,
} from './types.js'
import { readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import process from 'node:process'
import { routeHandler, withConnectionAuth } from 'dsh-tauri'
import { SESSION_API_PREFIX, SESSION_ARCHIVE_FILE, SESSION_PLUGIN_NAME } from './constants.js'
import { loadArchive, saveArchive, sessionStateDir } from './storage.js'

/** 插件名（诊断元数据，与导出的 name 一致）。 */
export const name = SESSION_PLUGIN_NAME

/** 需要的宿主服务：webServer（HTTP 路由）、sessions（会话枚举/header）、workspaceRegistry（归档集合）。 */
export const inject = ['webServer', 'sessions', 'workspaceRegistry', 'connection']

/** API 路由前缀（客户端同源 fetch）。 */
export const API_PREFIX = SESSION_API_PREFIX

function resolveDshHome(config: PluginConfig): string {
  return typeof config.dshHome === 'string' && config.dshHome ? config.dshHome : process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 查找会话对象（host ctx.sessions）。 */
function findSession(ctx: HostContext, sessionId: string): SessionLike | undefined {
  if (!sessionId)
    return undefined
  return (ctx.sessions?.get?.(sessionId) as SessionLike | undefined)
    ?? (ctx.sessions?.list?.() as SessionLike[] | undefined)?.find((session: SessionLike) => session.id === sessionId)
}

/** 会话工作目录（header.cwd）。 */
function sessionCwd(session: SessionLike | undefined): string | undefined {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

/** 组装 GET /archived 的载荷：宿主归档集合 id + 每个会话的创建元数据（读 host session header）。 */
function buildArchivedPayload(ctx: HostContext): ArchivedListPayload {
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
async function archiveSession(ctx: HostContext, body: Record<string, unknown>): Promise<ArchivedListPayload> {
  const sessionId = String(body.sessionId ?? '')
  if (!sessionId)
    throw new Error('缺少 sessionId')
  await requireArchiveSession(ctx)(sessionId)
  return buildArchivedPayload(ctx)
}

/** 归档一组会话（「归档工作区」：一次调用归档该组全部会话）。 */
async function archiveWorkspace(ctx: HostContext, body: Record<string, unknown>): Promise<ArchivedListPayload> {
  const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds.map(String) : []
  if (sessionIds.length === 0)
    throw new Error('缺少 sessionIds')
  const archiveSession = requireArchiveSession(ctx)
  for (const sessionId of sessionIds)
    await archiveSession(sessionId)
  return buildArchivedPayload(ctx)
}

/**
 * 宿主归档集合的私有状态机面。宿主公开 API 只有 `archiveSession`（没有 unarchive），
 * 而取消归档是插件的核心功能，因此这里显式依赖注册表内部方法：
 * `enqueueOperation`（串行化读改写）、`requireState`（当前持久化状态）、
 * `setState`（写回并发布）。三者任一缺失（宿主升级改内部结构）即报错，绝不静默降级。
 */
interface SessionStoreSurface {
  get?: (id: string) => SessionLike | undefined
  remove?: (id: string) => boolean
}

interface RegistryArchiveSurface {
  enqueueOperation?: (fn: () => Promise<void>) => Promise<void>
  requireState?: () => { archivedSessionIds?: readonly string[] }
  requireTable?: () => {
    entries: () => Iterable<[string, { sessionIds?: readonly string[] }]>
    update: (id: string, update: (record: { sessionIds?: readonly string[] }) => { sessionIds: string[] }) => Promise<void>
  }
  setState?: (state: unknown) => Promise<void>
}

function registryArchiveSurface(ctx: HostContext): RegistryArchiveSurface {
  const registry = ctx.workspaceRegistry as unknown as RegistryArchiveSurface | undefined
  if (!registry || typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function' || typeof registry.setState !== 'function')
    throw new Error('宿主 workspaceRegistry 未暴露归档集合的变更接口（宿主版本不兼容）')
  return registry
}

/** 归档所需方法缺失时报错，绝不静默跳过（否则迁移会误删旧记录）。 */
function requireArchiveSession(ctx: HostContext): (sessionId: string) => Promise<void> {
  const archiveSession = ctx.workspaceRegistry?.archiveSession
  if (typeof archiveSession !== 'function')
    throw new Error('宿主 workspaceRegistry 未提供 archiveSession（宿主版本不兼容）')
  return archiveSession.bind(ctx.workspaceRegistry) as (sessionId: string) => Promise<void>
}

/** Remove a session from every workspace accounting slot before physical deletion. */
async function removeSessionFromWorkspaceAccounting(ctx: HostContext, sessionIds: readonly string[]): Promise<void> {
  const registry = registryArchiveSurface(ctx)
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

/** 串行化地改写宿主归档集合（unarchive / clear 共用）。 */
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

/**
 * Restore the accounting slot when an older delete-all attempt removed it.
 * Normal archives already have the slot and this is a no-op; damaged historical
 * data is repaired from the session header cwd and the matching workspace path.
 */
async function restoreSessionWorkspaceAccounting(ctx: HostContext, sessionId: string): Promise<void> {
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

/** 取消归档：移除归档标记，并修复历史数据缺失的工作区归属槽位。 */
async function unarchiveSession(ctx: HostContext, body: Record<string, unknown>): Promise<{ ok: true }> {
  const sessionId = String(body.sessionId ?? '')
  if (!sessionId)
    throw new Error('缺少 sessionId')
  const registry = registryArchiveSurface(ctx)
  await registry.enqueueOperation!(async () => {
    await restoreSessionWorkspaceAccounting(ctx, sessionId)
    const state = registry.requireState!()
    const archived = [...(state.archivedSessionIds ?? [])]
    const next = archived.filter(id => id !== sessionId)
    if (next.length !== archived.length)
      await registry.setState!({ ...state, archivedSessionIds: next })
  })
  return { ok: true as const }
}

/** 判断一个路径是否是存在的目录。 */
function isDir(path: string): boolean {
  try {
    return readdirSync(path).length >= 0
  }
  catch {
    return false
  }
}

/** 规范化路径是否严格位于 sessionsRoot 之内（防 `..`/绝对路径逃逸）。 */
export function isWithinSessionsRoot(sessionsRoot: string, candidate: string): boolean {
  const root = resolve(sessionsRoot)
  const target = resolve(candidate)
  return target === root || target.startsWith(`${root}${sep}`)
}

/** 会话 id 是否为归档集合成员（删除的授权边界）。 */
function requireArchivedMember(ctx: HostContext, sessionId: string): void {
  const registry = ctx.workspaceRegistry as { archivedSessionIds?: readonly string[] } | undefined
  if (!registry?.archivedSessionIds?.includes(sessionId))
    throw new Error(`会话 '${sessionId}' 不在归档集合中，拒绝删除`)
}

/** Encode the session id exactly as the JSONL persistence backend does. */
export function encodeSessionId(id: string): string {
  if (id === '.')
    return '~002E'
  if (id === '..')
    return '~002E~002E'
  let encoded = ''
  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index)
    const char = String.fromCharCode(code)
    encoded += char !== '~' && /^[\w.-]$/.test(char)
      ? char
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}

/**
 * 物理删除一个会话的持久化目录（best-effort，找不到就跳过）。
 * dsh 宿主没有公开的「删除会话」API，会话数据存放在 `$DSH_HOME/sessions/<group>/session-<id>/`；
 * 这里做有界扫描（深度 2）命中 `session-<id>` 目录后删除。删除后宿主重启时
 * 会从持久化重建会话索引，该会话从工作区/归档中彻底消失。
 * @returns 是否实际删除了目录。
 */
function removeSessionDataDir(dshHome: string, sessionId: string): boolean {
  const sessionsRoot = join(dshHome, 'sessions')
  // DSH versions use either the raw id or the legacy `session-<id>` directory name.
  const encodedId = encodeSessionId(sessionId)
  const markers = [encodedId, `session-${sessionId}`, sessionId]
  // 一级：sessions/<id> or sessions/session-<id>
  for (const marker of markers) {
    const direct = join(sessionsRoot, marker)
    if (isWithinSessionsRoot(sessionsRoot, direct) && isDir(direct)) {
      rmSync(direct, { recursive: true, force: true })
      return true
    }
  }
  // 二级：sessions/<group>/session-<id>
  let groups: string[] = []
  try {
    groups = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  }
  catch {
    return false
  }
  for (const group of groups) {
    for (const marker of markers) {
      const nested = join(sessionsRoot, group, marker)
      if (isWithinSessionsRoot(sessionsRoot, nested) && isDir(nested)) {
        rmSync(nested, { recursive: true, force: true })
        return true
      }
    }
  }
  return false
}

/** 验证删除所需宿主面齐全；缺失时在变更前报错，保证可重试。 */
function requireDeletionSurfaces(ctx: HostContext, sessionIds: readonly string[]): { sessions: SessionStoreSurface | undefined } {
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

/** 从内存会话 store 移除（best-effort：live 会话必须成功）。 */
function removeLiveSessions(sessions: SessionStoreSurface | undefined, sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) {
    if (sessions?.get?.(sessionId) && !sessions.remove?.(sessionId))
      throw new Error(`无法从内存会话中移除 '${sessionId}'`)
  }
}

/** 彻底删除一个归档会话（成员校验 + 物理删除 + 记账更新）。 */
async function permanentlyDeleteSession(ctx: HostContext, dshHome: string, body: Record<string, unknown>): Promise<{ ok: true }> {
  const sessionId = String(body.sessionId ?? '')
  if (!sessionId)
    throw new Error('缺少 sessionId')
  requireArchivedMember(ctx, sessionId)
  const { sessions } = requireDeletionSurfaces(ctx, [sessionId])
  // 先物理删除，再更新记账：物理删除失败时归档集合未动，会话仍可寻址重试。
  const removed = removeSessionDataDir(dshHome, sessionId)
  removeLiveSessions(sessions, [sessionId])
  await removeSessionFromWorkspaceAccounting(ctx, [sessionId])
  await updateRegistryArchiveSet(ctx, ids => ids.filter(id => id !== sessionId))
  ctx.logger?.info?.(`[${SESSION_PLUGIN_NAME}] permanently deleted archived session (data removed: ${removed})`)
  return { ok: true as const }
}

/** 彻底删除指定归档会话（先物理删除全部，再批量更新记账）。 */
async function permanentlyDeleteSelected(ctx: HostContext, dshHome: string, body: Record<string, unknown>): Promise<{ ok: true }> {
  const rawIds = body.sessionIds
  if (!Array.isArray(rawIds) || rawIds.length === 0)
    throw new Error('缺少 sessionIds')
  const ids = [...new Set(rawIds.map(String).filter(Boolean))]
  for (const sessionId of ids)
    requireArchivedMember(ctx, sessionId)
  const { sessions } = requireDeletionSurfaces(ctx, ids)
  let removed = 0
  for (const sessionId of ids) {
    if (removeSessionDataDir(dshHome, sessionId))
      removed += 1
  }
  removeLiveSessions(sessions, ids)
  await removeSessionFromWorkspaceAccounting(ctx, ids)
  await updateRegistryArchiveSet(ctx, current => current.filter(id => !ids.includes(id)))
  ctx.logger?.info?.(`[${SESSION_PLUGIN_NAME}] permanently deleted ${ids.length} selected archived session(s) (data removed: ${removed})`)
  return { ok: true as const }
}

/** 彻底删除全部已归档会话（先物理删除全部，再批量更新记账）。 */
async function permanentlyDeleteAll(ctx: HostContext, dshHome: string): Promise<{ ok: true }> {
  const registry = ctx.workspaceRegistry as { archivedSessionIds?: readonly string[] } | undefined
  const ids = [...(registry?.archivedSessionIds ?? [])]
  const { sessions } = requireDeletionSurfaces(ctx, ids)
  let removed = 0
  // 全部先物理删除：任一会话目录删除失败即中止，归档集合保持不变可重试。
  for (const sessionId of ids) {
    if (removeSessionDataDir(dshHome, sessionId))
      removed += 1
  }
  removeLiveSessions(sessions, ids)
  await removeSessionFromWorkspaceAccounting(ctx, ids)
  await updateRegistryArchiveSet(ctx, () => [])
  ctx.logger?.info?.(`[${SESSION_PLUGIN_NAME}] permanently deleted ${ids.length} archived session(s) (data removed: ${removed})`)
  return { ok: true as const }
}

/**
 * 一次性迁移旧版插件自持归档（`$DSH_HOME/dsh-tauri-session/archive.json`）到宿主
 * 归档集合。迁移成功的记录从旧文件中移除；仍失败的（如会话已不存在）保留在旧
 * 文件中，下次启动幂等重试 —— 绝不因单次失败丢弃用户数据。
 */
async function migrateLegacyArchive(ctx: HostContext, dshHome: string): Promise<void> {
  const legacy = loadArchive(dshHome)
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
      saveArchive(remaining, dshHome)
    }
  }
  catch {
    // 旧文件整理失败不影响新机制（下次启动会再尝试迁移）。
  }
  ctx.logger?.info?.(`[${SESSION_PLUGIN_NAME}] migrated ${migrated}/${sessionIds.length} legacy archived session(s) into the host registry`)
}

/** 构建路由列表。 */
export function buildRoutes(ctx: HostContext, dshHome: string): any[] {
  const routes = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/archived`,
      handler: routeHandler(async () => [200, buildArchivedPayload(ctx)]),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/archive`,
      handler: routeHandler(async body => [200, await archiveSession(ctx, body)], { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/archive-workspace`,
      handler: routeHandler(async body => [200, await archiveWorkspace(ctx, body)], { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/unarchive`,
      handler: routeHandler(async body => [200, await unarchiveSession(ctx, body)], { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/delete`,
      handler: routeHandler(async body => [200, await permanentlyDeleteSession(ctx, dshHome, body)], { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/delete-workspace`,
      handler: routeHandler(async body => [200, await permanentlyDeleteSelected(ctx, dshHome, body)], { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/clear`,
      handler: routeHandler(async () => [200, await permanentlyDeleteAll(ctx, dshHome)], { mutate: true }),
    },
  ]
  return routes.map(route => ({
    ...route,
    handler: withConnectionAuth(ctx.connection, route.handler, 'dsh-tauri-session'),
  }))
}

/**
 * 插件体：迁移旧版归档 + 注册 HTTP 路由。
 * @param ctx - 宿主根上下文（注入 webServer/sessions/workspaceRegistry）。
 * @param config - 插件行配置（dshHome 等，仅用于旧版归档迁移路径）。
 */
export function apply(ctx: HostContext, config: PluginConfig = {}): void {
  const cfg = config ?? {}
  const dshHome = resolveDshHome(cfg)

  // 旧版自持归档一次性迁入宿主集合（幂等：文件不存在或为空则直接跳过）。
  ctx.effect(() => {
    void migrateLegacyArchive(ctx, dshHome)
  }, `${SESSION_PLUGIN_NAME}: migrate legacy archive`)

  // HTTP 路由注册（客户端经此调用 archived/archive/unarchive/delete/clear）。
  ctx.effect(() => {
    const disposers = buildRoutes(ctx, dshHome).map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers)
        dispose()
    }
  }, `${SESSION_PLUGIN_NAME}: routes`)
}
