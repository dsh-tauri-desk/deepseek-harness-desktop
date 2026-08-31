export type HostContext = any

export type JsonBody = Record<string, unknown>

export type RouteResult = [number, unknown]
export type RouteFunction = (body: JsonBody, req: import('node:http').IncomingMessage) => Promise<RouteResult>

export interface PluginConfig {
  /** 旧版自持归档的根目录（v1 迁移用；默认 `~/.dsh`）。 */
  dshHome?: string
}

/**
 * 旧版（v1）插件自持归档记录 —— 仅用于启动时一次性迁入宿主归档集合。
 * v2 起归档集合由宿主 WorkspaceRegistry 持有：归档不动工作区记账，会话保留
 * 其 `sessionIds` 槽位，取消归档自动恢复原组原位。
 */
export interface ArchivedSessionRecord {
  sessionId: string
  /** The workspace group the session belonged to when archived (for grouping). */
  workspaceId?: string
  /** The session that preceded it in the workspace order at archive time. */
  beforeSessionId?: string
  /** Epoch ms when it was archived. */
  archivedAt: number
}

/** Whole archive document keyed by session id. */
export type ArchiveDocument = Record<string, ArchivedSessionRecord>

/** Minimal host session header surface (createdAt/cwd live on the host Session.header). */
export interface SessionHeaderLike {
  createdAt?: number
  cwd?: string
}

/** Minimal host session surface used by this plugin. */
export interface SessionLike {
  id: string
  header?: SessionHeaderLike
  title?: string
  displayTitle?: string
}

/** Wire payload for `GET /api/dsh-session/archived`. */
export interface ArchivedListPayload {
  archivedSessionIds: string[]
  /** Per archived session, creation metadata read from the host session header. */
  meta: Record<string, { createdAt?: number, cwd?: string, title?: string }>
}
