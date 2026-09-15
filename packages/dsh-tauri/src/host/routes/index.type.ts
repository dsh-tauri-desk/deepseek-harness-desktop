/**
 * host/routes/index.type.ts — 宿主路由工具的类型出口。
 *
 * 本工具的类型声明面全部在这里：宿主能力子集、路由身份、注册器、声明回调与运行期注册函数。
 * 实现见 ./index.ts；按仓库约定，使用方从本文件取类型，主文件不再转出类型。
 *
 * 本工具不依赖任何底座包，因此这里只声明自己真正消费的宿主能力子集：字段名与
 * @deepseek-ai/dsh-host-webserver 的 register 契约、主包的 ConnectionGate 鉴权边界
 * 逐字一致，调用方可直接传插件 ctx（结构兼容，不需要适配或断言）。
 */
import type { EventHandler } from 'h3'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 宿主 webserver 的两张匹配表：exact 精确命中；prefix 按 `prefix + '/'` 边界最长前缀优先。 */
export type RouteKind = 'exact' | 'prefix'

/** 本工具支持声明的方法集（CONNECT/TRACE/QUERY 对桌面 JSON API 无意义，故意不收）。 */
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/** 节点风格处理器：宿主把整个响应的所有权交给它（不会再有兜底写出）。 */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

/** 一行宿主路由注册项。 */
export interface HostRoute {
  kind: RouteKind
  path: string
  handler: RouteHandler
}

/** 只取用到的 webServer 能力：register 返回卸载函数；重复 (kind, path) 由宿主抛错。 */
export interface WebServerLike {
  register: (route: HostRoute) => () => void
}

/** DSH Connection 的浏览器信任边界。 */
export interface ConnectionGate {
  requestRejection: (request: IncomingMessage) => 401 | 403 | undefined
}

export interface RouteLogger {
  error: (message: string) => void
}

/**
 * `registerRoutes(ctx)` 需要的宿主面（插件 HostContext 的结构子集）。
 *
 * 同一个对象会原样暴露给子路由：`event.context.dsh`。因此它既是注册期的依赖，
 * 也是 handler 里拿回 ctx（进而 `ctx.sessions` / `ctx.get(...)` 等）的入口。
 */
export interface RoutesContext {
  webServer: WebServerLike
  connection?: ConnectionGate
  logger?: RouteLogger
}

/** 一次路由声明的宿主级身份。 */
export interface RouteDefinition {
  /** 命中宿主哪张表：`exact` 精确；`prefix` 最长前缀优先。 */
  kind: RouteKind
  /** 原样交给宿主与 h3 的路径；两侧必须逐字一致，因此这里不做任何归一化。 */
  path: string
}

/** 单个方法动词的注册签名；返回注册器本身以支持链式声明。 */
export type RouteMethod = (definition: RouteDefinition, handler: EventHandler) => RouteDisposer

/** 路由注册器（声明回调的参数）：HTTP 方法动词 + 显式 `on()` 兜底。 */
export interface RouteDisposer {
  get: RouteMethod
  head: RouteMethod
  post: RouteMethod
  put: RouteMethod
  patch: RouteMethod
  delete: RouteMethod
  options: RouteMethod
  /** 兜底入口：显式指定方法（大小写不敏感），非法方法在声明期直接抛错。 */
  on: (method: HttpMethod | Lowercase<HttpMethod>, definition: RouteDefinition, handler: EventHandler) => RouteDisposer
}

/** 路由声明回调：只在 defineRoutes 期间被调用一次，此时还不需要 ctx。 */
export type RoutesSetup = (disposer: RouteDisposer) => void

/**
 * `defineRoutes` 的返回值：运行期用宿主 ctx 完成注册，返回卸载本次注册的 disposer。
 *
 * 它不读 `this`：ctx 必须显式传入（`registerRoutes(ctx)`），因此在任何调用位置都成立，
 * 不依赖 cordis 的 `execute.call(ctx)` 绑定。
 *
 * 第二参数是本次注册携带的 apply 期依赖，由 `withDshContext` 挂到 `event.context.dshDeps`
 * 供 handler 用 `dshRouteDepsOf` 取回。`Deps` 为 undefined（默认）时该参数可省略，零依赖
 * 插件写法保持 `routes(ctx)` 不变；声明了 deps 却漏传会变成编译期错误，而不是请求期的
 * 「路由依赖未随注册传入」。
 */
export type RoutesRegistration<Deps = undefined>
  = undefined extends Deps
    ? (ctx: RoutesContext, deps?: Deps) => () => void
    : (ctx: RoutesContext, deps: Deps) => () => void
