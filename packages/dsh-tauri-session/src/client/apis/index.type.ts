/** GET /session/archive 响应：归档会话 id 集 + 创建元数据。 */
export interface ArchivedListPayload {
  archivedSessionIds: string[]
  /** Per archived session, creation metadata read from the host session header. */
  meta: Record<string, { createdAt?: number, cwd?: string, title?: string }>
}

/** 变更类动作的宿主结果体（200 返回；error 为宿主侧诊断文案）。 */
export interface ActionResult {
  ok: boolean
  error?: string
}

/** POST /session/archive、/session/unarchive、/session/open-path、DELETE /session/archive 请求体。 */
export interface PostSessionIdBody {
  sessionId: string
}

/** POST /session/workspace/archive 请求体。 */
export interface PostArchiveWorkspaceBody {
  workspaceId: string
  sessionIds: readonly string[]
}

/** DELETE /session/workspace/archive 请求体。 */
export interface PostDeleteWorkspaceBody {
  sessionIds: readonly string[]
}
