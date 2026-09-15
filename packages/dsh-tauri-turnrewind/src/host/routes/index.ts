/**
 * host/routes/index.ts — turnrewind HTTP 路由（客户端 UI 唯一的数据面）。
 *
 *   GET  /api/turnrewind/session/summary?sessionId=<id>  读本会话的 turn 变更记录
 *   GET  /api/turnrewind/session/live?sessionId=<id>     读运行中实时读数（客户端提示条）
 *   POST /api/turnrewind/session/undo                    撤销某个 turn 的文件改动
 *
 * 「文件路径 = URL 路径」：`routes/session/<子资源>/<方法>.ts` 逐段对应
 * `${TURNREWIND_API_PREFIX}/session/<子资源>`；改目录必须同步 `client/apis` 的 URL。
 * 方法限制、OPTIONS 204、连接信任边界与请求体上限全部由 `defineRoutes` 承担。
 * 处理器不接收 apply 期依赖：宿主能力一律经 `service/` 访问。
 */

import { defineRoutes } from 'dsh-tauri'
import { TURNREWIND_API_PREFIX } from '../../shared/constants'
import live from './session/live/get'
import summary from './session/summary/get'
import undo from './session/undo/post'

export const routes = defineRoutes((disposer) => {
  disposer.get({ kind: 'exact', path: `${TURNREWIND_API_PREFIX}/session/summary` }, summary)
  disposer.get({ kind: 'exact', path: `${TURNREWIND_API_PREFIX}/session/live` }, live)
  disposer.post({ kind: 'exact', path: `${TURNREWIND_API_PREFIX}/session/undo` }, undo)
})
