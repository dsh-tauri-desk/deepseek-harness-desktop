/**
 * host/apply.ts — 宿主半区装配：注入依赖并注册 /message-tree 路由。
 *
 * 注意：这里列出的服务都是**按属性访问**的，必须全部声明在 inject 里——cordis 的
 * ctx 代理对未声明的服务会抛 `cannot get property "<name>" without inject`，而
 * apply() 里抛异常会让整个 loader entry 失败（桌面端会显示插件恢复页）。
 * 可选服务（connection / agentPresets）一律用 `ctx.get(name)` 反射读取。
 *
 * workspaceRegistry 被三处使用：在树载荷里标记已归档版本（应用无法导航到已归档会话，
 * 客户端据此先取消归档）、按需取消归档、把新版本挂到与父相同的侧栏工作区分组。
 */

import type { HostContext } from './types'
import { buildRoutes } from './routes'

/** 宿主依赖：会话存储、Agent 注册表、会话持久化与查询、Web 服务器、工作区注册表。 */
export const inject = [
  'sessions',
  'agents',
  'sessionPersistence',
  'sessionQuery',
  'webServer',
  'workspaceRegistry',
]

/**
 * 宿主插件体。
 * @param ctx - 宿主根上下文。
 */
export function apply(ctx: HostContext): void {
  ctx.effect(() => {
    const disposers: Array<() => void> = buildRoutes(ctx).map((route: any) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers)
        dispose()
    }
  }, 'message-tree: HTTP route')
}
