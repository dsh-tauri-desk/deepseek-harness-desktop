import type {
  ActionOutcome,
  SessionId,
  SessionsRuntimeLike,
  WorkspaceId,
  WorkspacesRuntimeLike,
  WorkspaceViewLike,
} from '../types'
import { difference, filter, get } from 'dsh-tauri/client'
import { postOpenPath, postOpenUrl } from '../apis'
import { locale } from '../locales'
import { externalUrl } from '../utils/url'

/** Action：用系统默认浏览器打开外链（只放行 http/https）。 */
export async function openExternalUrl(input: { url: string }): Promise<ActionOutcome> {
  const url = externalUrl(input.url)
  if (!url)
    return { ok: false, error: locale.text('openFailed', { reason: locale.text('invalidLink') }) }
  try {
    const result = await postOpenUrl({ url })
    if (!result?.ok)
      return { ok: false, error: locale.text('openFailed', { reason: result?.error || locale.text('unknownError') }) }
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Action：在系统文件管理器中打开目录（插件自家宿主路由，不依赖核心 Remote）。 */
export async function openInExplorer(input: { path: string }): Promise<ActionOutcome> {
  try {
    const result = await postOpenPath({ path: input.path })
    if (!result?.ok)
      return { ok: false, error: locale.text('openFailed', { reason: result?.error || locale.text('unknownError') }) }
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Action：重命名会话（官方重命名不可用时的回退路径）。 */
export async function renameSession(input: {
  sessions: SessionsRuntimeLike
  sessionId: SessionId
  title: string
}): Promise<ActionOutcome> {
  const binding = input.sessions.binding(input.sessionId)
  if (!binding)
    return { ok: false, error: locale.text('sessionServiceUnavailable') }
  try {
    const result = await binding.session.rename(input.title)
    if (!result.ok)
      return { ok: false, error: result.error?.message || locale.text('renameFailed') }
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Action：归档单个会话（官方归档不可用时的回退路径）。 */
export async function archiveSession(input: {
  workspaces: WorkspacesRuntimeLike
  sessionId: SessionId
}): Promise<ActionOutcome> {
  try {
    await input.workspaces.archiveSession(input.sessionId)
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Action：分叉会话（官方分叉不可用时的回退路径）。 */
export async function forkSession(input: {
  sessions: SessionsRuntimeLike
  sessionId: SessionId
}): Promise<ActionOutcome> {
  try {
    const childId = await input.sessions.fork({ sessionId: input.sessionId, increaseTitle: true })
    input.sessions.open(childId)
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Query：未分组中的正式会话 id（排除已归档、已归属工作区与空白会话）。 */
export async function loadUngroupedSessions(input: {
  workspaces: WorkspacesRuntimeLike
  sessions: SessionsRuntimeLike
}): Promise<SessionId[]> {
  const snapshot = input.workspaces.list.getSnapshot()
  const assigned = snapshot.items.flatMap(workspace => workspace.sessionIds)
  const sessionSnapshot = input.sessions.list.getSnapshot()
  return filter(
    difference(sessionSnapshot.ids, assigned, snapshot.archivedSessionIds),
    id => sessionSnapshot.byId[id]?.blank !== true,
  )
}

/** Query：工作区中尚未归档的会话 id。 */
export async function loadWorkspaceSessions(input: {
  workspaces: WorkspacesRuntimeLike
  workspace: WorkspaceViewLike
}): Promise<SessionId[]> {
  return difference(input.workspace.sessionIds, input.workspaces.list.getSnapshot().archivedSessionIds)
}

/** Action：逐个归档会话。 */
export async function archiveSessions(input: {
  workspaces: WorkspacesRuntimeLike
  sessionIds: SessionId[]
}): Promise<ActionOutcome> {
  try {
    for (const sessionId of input.sessionIds)
      await input.workspaces.archiveSession(sessionId)
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Action：删除工作区（官方非破坏性删除：仅移除注册，文件夹与会话记录保留）。 */
export async function deleteWorkspace(input: {
  workspaces: WorkspacesRuntimeLike
  workspaceId: WorkspaceId
}): Promise<ActionOutcome> {
  try {
    await input.workspaces.delete(input.workspaceId)
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

// --- internal ---

function fail(error: unknown): ActionOutcome {
  return { ok: false, error: get(error, 'message') || String(error) }
}
