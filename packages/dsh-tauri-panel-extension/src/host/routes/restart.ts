/**
 * routes/restart.ts — 独立 `dsh web` 的自重启路由。
 *
 * 进程控制：仅直接的同源回环请求（trustedRestartRequest）有权触发；桌面模式下
 * 重启归壳层所有（restartOwnedByShell 返回 409），避免被监督的 sidecar 自我替换。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RouteRegistrar } from '../types.ts'
import { sendJson } from 'dsh-tauri'
import { API_PREFIX } from '../../shared/constants.ts'
import { dshLaunch, restartOwnedByShell, scheduleRestart, trustedRestartRequest } from '../restart.ts'

export function registerRestartRoute(register: RouteRegistrar): Array<() => void> {
  return [
    register({
      kind: 'exact',
      path: `${API_PREFIX}/restart`,
      handler: (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!trustedRestartRequest(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (restartOwnedByShell()) {
          sendJson(response, 409, { error: 'restart is owned by the desktop shell' })
          return
        }
        const { pid, replacementPid, logOut } = scheduleRestart(dshLaunch())
        sendJson(response, 200, { ok: true, pid, replacementPid, logOut })
      },
    }),
  ]
}
