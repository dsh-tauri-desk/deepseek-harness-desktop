/** Host-half shared types for dsh-tauri-rightclick. */

/** 宿主上下文（沿用工作区先例：插件按需解构具体服务）。 */
export type HostContext = any

/** 路由处理器收到的 JSON 请求体。 */
export type JsonBody = Record<string, unknown>

export type RouteResult = [number, unknown]
export type RouteFunction = (body: JsonBody, req: import('node:http').IncomingMessage) => Promise<RouteResult>

/** 每个 host route 的注册描述（传给 ctx.webServer.register）。 */
export interface HostRoute {
  kind: 'exact'
  path: string
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
}
