/**
 * dsh-tauri-rightclick 宿主侧（node half）：系统浏览器开链。
 *
 * 客户端（src/client/）负责右键菜单的 DOM 交互；本 half 只提供宿主能力：
 *   - POST /api/dsh-rightclick-menu/open-url 用系统默认浏览器打开 http/https 外链
 *     （Harness 的 host.openPath 只接受文件系统路径，URL 必须走这里）。
 *
 * 路由只接受同源 JSON POST（isSameOriginJsonRequest 校验）。
 */

import type { HostContext, HostRoute } from './types.js'
import { isSameOriginJsonRequest, openUrl, readJsonBody, respond, safeWebUrl, withConnectionAuth } from 'dsh-tauri'
import {
  OPEN_URL_ROUTE,
  RIGHTCLICK_API_PREFIX,
  RIGHTCLICK_PLUGIN_NAME,
} from './constants.js'

/** 插件名（诊断元数据，与导出的 name 一致）。 */
export const name = RIGHTCLICK_PLUGIN_NAME

/**
 * 需要的宿主服务：webServer（HTTP 路由）、sessionPersistence（定位会话文件）、
 *  workspaceRegistry（归档过渡/记账）、agents（停止运行中会话）、
 *  sessions（live session 脱离）、storageDomain（投影/工作区账本）。
 */
export const inject = ['webServer', 'connection']

/** API 路由前缀（客户端同源 fetch）。 */
export const API_PREFIX = RIGHTCLICK_API_PREFIX

/** 构建路由列表。 */
export function buildRoutes(ctx: HostContext): HostRoute[] {
  // 串行化变更操作：每个宿主变更依次排队执行。
  let mutationTail: Promise<unknown> = Promise.resolve()
  const withMutationLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation, operation)
    mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  const routes: HostRoute[] = [
    {
      kind: 'exact',
      path: OPEN_URL_ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'POST')
          return respond(response, 405, { ok: false, error: 'method-not-allowed' })
        const validation = isSameOriginJsonRequest(request)
        if (!validation.ok)
          return respond(response, validation.status, { ok: false, error: validation.error })
        let body
        try {
          body = await readJsonBody(request)
        }
        catch {
          return respond(response, 400, { ok: false, error: 'bad-request' })
        }
        const url = safeWebUrl(body?.url)
        if (!url)
          return respond(response, 400, { ok: false, error: 'invalid-url' })
        return withMutationLock(async () => {
          try {
            await openUrl(url)
            respond(response, 200, { ok: true })
          }
          catch (error) {
            ctx.logger?.warn?.(`[${RIGHTCLICK_PLUGIN_NAME}] failed to open URL ${url}:`, error)
            respond(response, 500, { ok: false, error: 'open-url-failed' })
          }
        })
      },
    },
  ]
  return routes.map(route => ({
    ...route,
    handler: withConnectionAuth(ctx.connection, route.handler, 'dsh-tauri-rightclick'),
  }))
}

/**
 * 插件体：注册 HTTP 路由。
 * @param ctx - 宿主根上下文（注入 webServer/sessionPersistence/workspaceRegistry/
 *   agents/sessions/storageDomain）。
 */
export function apply(ctx: HostContext): void {
  ctx.effect(() => {
    const disposers = buildRoutes(ctx).map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers)
        dispose()
    }
  }, `${RIGHTCLICK_PLUGIN_NAME}: routes`)
}
