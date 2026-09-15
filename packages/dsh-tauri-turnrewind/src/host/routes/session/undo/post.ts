/**
 * POST /api/turnrewind/session/undo — 撤销某个 turn 的文件改动（唯一的写路由）。
 *
 * 写边界（方法限制、连接信任、非回环 403、跨源 403）由 `defineRoutes` 统一承担；
 * 这里只做参数校验与撤销转发。响应形状：成功 `{ ok: true, restored, removed, failed }`，
 * 失败 `{ error, conflicts }` + 业务状态码。
 */

import type { UndoResponse } from '../../../types'
import { defineEventHandler, readBody } from 'dsh-tauri'
import { undo } from '../../../service/undo'
import { workspace } from '../../../service/workspace'

/** 撤销请求体（形状校验在处理器内做，绝不信客户端类型）。 */
interface UndoBody {
  sessionId?: unknown
  turn?: unknown
}

export default defineEventHandler(async (event): Promise<UndoResponse> => {
  const body = (await readBody<UndoBody>(event)) ?? {}
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const turn = Number(body.turn)
  if (sessionId.length === 0) {
    event.res.status = 400
    return { error: '缺少 sessionId' }
  }
  if (!Number.isInteger(turn) || turn <= 0) {
    event.res.status = 400
    return { error: 'turn 必须是正整数' }
  }
  if (!workspace.peek(sessionId)) {
    event.res.status = 404
    return { error: '会话不存在或尚未就绪' }
  }
  const outcome = await undo.turn(sessionId, turn)
  if (outcome.ok)
    return { ok: true, restored: outcome.restored, removed: outcome.removed, failed: outcome.failed }
  event.res.status = outcome.code
  return { error: outcome.error, conflicts: outcome.conflicts ?? [] }
})
