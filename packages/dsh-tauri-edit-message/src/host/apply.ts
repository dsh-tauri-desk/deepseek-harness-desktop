/**
 * host/apply.ts — 宿主半区装配：注入依赖并注册 /message-tree 路由。
 *
 * 注意：这里列出的服务都是**按属性访问**的，必须全部声明在 inject 里——cordis 的
 * ctx 代理对未声明的服务会抛 `cannot get property "<name>" without inject`，而
 * apply() 里抛异常会让整个 loader entry 失败（桌面端会显示插件恢复页）。
 * 可选服务（connection / workspaceRegistry）一律用 `ctx.get(name)` 反射读取。
 *
 * 与 DSH-EasyRewrite 一致：宿主半区**不注入 agents**——边界解析与树投影都是只读的，
 * 因此源会话绝不会因为一次编辑而被重新激活。
 */

import type { HostContext } from './types'
import { buildRoutes } from './routes'

/** 宿主依赖：会话存储、会话查询、Web 服务器。 */
export const inject = ['sessions', 'agents', 'sessionQuery', 'webServer']

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
