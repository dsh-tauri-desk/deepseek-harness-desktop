/**
 * host/routes/index.ts — 宿主 HTTP 路由声明工具：h3 风格的处理器，落到宿主 webserver 上。
 *
 * 声明期（模块顶层，此时拿不到 ctx）只登记「哪个方法打到哪个路径」：
 * ```ts
 * const registerRoutes = defineRoutes((disposer) => {
 *   disposer.get(
 *     { kind: 'exact', path: '/api/demo' },
 *     defineEventHandler(event => ({ ok: true })),
 *   )
 * })
 * ```
 *
 * 运行期（插件 apply 里拿到 ctx 之后）才真正注册，返回值是卸载函数：
 * ```ts
 * ctx.effect(() => registerRoutes(ctx), 'demo: routes')
 * ```
 *
 * 安全边界由本工具统一承担（各 handler 不必重复实现）：
 *   - `ctx.connection.requestRejection` 命中 → 401/403；
 *   - 变更方法（POST/PUT/PATCH/DELETE）非回环来源 → 403；
 *   - 变更方法带 `Origin` 且与 `Host` 不符（CSRF / DNS rebinding）→ 403。
 *
 * 子路由里用 `event.context.dsh` 拿回宿主 ctx：
 * ```ts
 * disposer.get({ kind: 'exact', path: '/api/demo' }, defineEventHandler((event) => {
 *   const ctx = dshContextOf(event) // 或直接读 event.context.dsh
 *   return { ok: ctx !== undefined }
 * }))
 * ```
 *
 * apply 期依赖（配置 / 数据根 / 服务实例）同理，经注册期第二参数传入、请求期取回：
 * ```ts
 * const deps: DemoDeps = { config, root }
 * ctx.effect(() => registerRoutes(ctx, deps), 'demo: routes')
 *
 * // handler 内：
 * const { config, root } = dshRouteDepsOf<DemoDeps>(event)!
 * ```
 * 依赖不落模块级全局：同一份声明在两组 deps 下各注册一次时各读各的（单测在同一进程里建多个
 * harness 即命中），先注册的不会被后注册的覆盖。
 */

import type { EventHandler, H3Event } from 'h3'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  ConnectionGate,
  HostRoute,
  HttpMethod,
  RouteDefinition,
  RouteDisposer,
  RouteHandler,
  RouteMethod,
  RoutesContext,
  RoutesRegistration,
  RoutesSetup,
} from './index.type'
import { bodyLimit, H3 } from 'h3'
import { toNodeHandler } from 'h3/node'
import { MAX_REQUEST_BODY_BYTES } from '../config/constants'

/** 节点 handler 类型由 toNodeHandler 反推，避免额外依赖 NodeHandler 的类型出口。 */
type HostNodeHandler = ReturnType<typeof toNodeHandler>

/** 变更操作方法集：必须来自本机回环地址。 */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** 支持声明的方法全集，同时充当 allow 头的规范顺序。 */
const SUPPORTED_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

/** 声明期收集到的一条路由。 */
interface CollectedRoute {
  method: HttpMethod
  definition: RouteDefinition
  handler: EventHandler
}

/** 收敛后的宿主注册单元：一条 (kind, path) + 该路径已声明的方法集。 */
interface RouteGroup {
  definition: RouteDefinition
  methods: ReadonlySet<HttpMethod>
}

/**
 * 声明一组宿主 HTTP 路由，返回运行期注册函数。
 *
 * 处理器需要 apply 期依赖（配置、数据根、服务实例）时，用类型参数声明 deps 形状，
 * 注册期经第二参数传入，handler 里用 `dshRouteDepsOf(event)` 取回：
 * ```ts
 * export const routes = defineRoutes<DemoDeps>((disposer) => {
 *   disposer.post({ kind: 'exact', path: '/api/demo' }, handler)
 * })
 * ctx.effect(() => routes(ctx, deps), 'demo: routes')
 * ```
 * deps 由本次注册的闭包捕获（不落模块级全局）：同一份声明被两组 deps 各注册一次时各读各的依赖。
 *
 * @param setup - 路由声明回调；在此用 `disposer.get(...)` / `disposer.post(...)` 登记路由。
 * @returns `registerRoutes(ctx, deps?)`：注册全部路由并返回卸载函数（配合 `ctx.effect` 使用）。
 */
export function defineRoutes<Deps = undefined>(setup: RoutesSetup): RoutesRegistration<Deps> {
  if (typeof setup !== 'function')
    throw new TypeError('defineRoutes: 缺少路由声明回调，签名是 defineRoutes(setup)')

  const collected: CollectedRoute[] = []
  setup(createDisposer(collected))
  // 声明期即快照：一次 defineRoutes 对应一次注册，回调返回后再追加不会再生效。
  const declared: readonly CollectedRoute[] = collected.slice()

  const registration = function registerRoutes(ctx: RoutesContext, deps?: Deps): () => void {
    // ctx 显式传入，没有 this 兜底：缺失时立刻报清楚，而不是等 register 时才发现。
    if (typeof ctx?.webServer?.register !== 'function')
      throw new TypeError('defineRoutes: registerRoutes(ctx) 需要传入带 webServer 服务的宿主 ctx')

    const webServer = ctx.webServer
    // 连接信任边界服务必须在注册期取到：cordis 对未进 inject 的服务在属性访问时抛错，
    // 留到请求期只会被宿主兜底成裸 400（无日志无 content-type），这里让它当启动期报错。
    const connection = ctx.connection
    const app = new H3({
      // h3 自己把 handler 异常转成 500 响应，宿主 webserver 的兜底 catch 不会再触发，这里才是唯一日志出口。
      // 回调必须是语句体（返回 void）：h3 会把 onError 的非空返回值当成**替换响应**，
      // 一旦写成 `error => logger.error(msg)`（error() 返回 push 的数字）就会把 500 变成 200。
      onError: (error) => {
        ctx.logger?.error(`[dsh-tauri] 路由处理失败: ${error.stack ?? error.message}`)
      },
    })
    // 请求体上限用 h3 内置的 bodyLimit 中间件（不是 handler 里的手写字节计数）：
    // 超限请求在 handler 读取请求体时以 413 结束，不会先整份读进内存。
    app.use(bodyLimit(MAX_REQUEST_BODY_BYTES))
    for (const route of declared)
      app.on(route.method, toH3Pattern(route.definition), withDshContext(route.handler, ctx, deps))

    const node = toNodeHandler(app)
    const disposers: Array<() => void> = []
    try {
      for (const group of groupRoutes(declared)) {
        const route: HostRoute = {
          kind: group.definition.kind,
          path: group.definition.path,
          handler: createHostHandler(connection, node, group),
        }
        disposers.push(webServer.register(route))
      }
    }
    catch (error) {
      // 宿主重复注册会抛错：回滚本次已注册的行，不留下半个路由表。
      for (const dispose of disposers.reverse())
        dispose()
      throw error
    }

    return () => {
      for (const dispose of disposers)
        dispose()
    }
  }

  // 返回类型是条件类型（Deps 为 undefined 时 deps 可省略），实现签名用可选参数即可覆盖两种
  // 形态；泛型未解析时 TS 无法静态验证对条件类型的可赋值性，故此处断言一次。
  return registration as RoutesRegistration<Deps>
}

/**
 * 类型化读取子路由里的宿主 ctx。
 *
 * h3 的 `H3EventContext` 继承 srvx 的 `ServerRequestContext`（带 `[key: string]: unknown`
 * 索引签名），所以 `event.context.dsh` 本身就能读写，只是静态类型是 `unknown`；需要类型
 * 时用这个函数，或自行断言。
 * @param event - h3 事件。
 * @returns 注册该路由时传入的宿主 ctx；未经本工具注册的 handler 里为 undefined。
 */
export function dshContextOf(event: H3Event): RoutesContext | undefined {
  return event.context.dsh as RoutesContext | undefined
}

/**
 * 类型化读取子路由里的注册期依赖（由 `registerRoutes(ctx, deps)` 随注册传入）。
 *
 * 与 `dshContextOf` 对称：deps 挂在 `event.context.dshDeps`，静态类型是 `unknown`，
 * 需要类型时用这个函数，或自行断言。
 * @param event - h3 事件。
 * @returns 注册该路由时传入的 deps；零依赖注册或未经本工具注册的 handler 里为 undefined。
 */
export function dshRouteDepsOf<Deps>(event: H3Event): Deps | undefined {
  return event.context.dshDeps as Deps | undefined
}

/**
 * 逐条包裹 handler，把宿主 ctx 与本次注册的依赖挂到事件上下文供子路由读取。
 *
 * 逐条包裹而不是挂中间件：这样 `dsh` / `dshDeps` 必定在业务 handler 之前就位，也不受 h3
 * 中间件注册顺序影响。返回值必须原样透传，否则会把 handler 的响应体吞成 undefined。
 *
 * deps 只存在于本次注册的闭包里，不落模块级全局：两次注册各持有各自的依赖。
 */
function withDshContext<Deps>(handler: EventHandler, ctx: RoutesContext, deps: Deps): EventHandler {
  return (event) => {
    event.context.dsh = ctx
    event.context.dshDeps = deps
    return handler(event)
  }
}

/** 构造注册器；一次 defineRoutes 对应一个收集数组。 */
function createDisposer(collected: CollectedRoute[]): RouteDisposer {
  // 先声明后赋值：方法动词要返回注册器本身（链式声明），才能避免对 self 的前向引用。
  let disposer: RouteDisposer
  const push = (method: HttpMethod): RouteMethod => (definition, handler) => {
    collected.push({ method, definition, handler })
    return disposer
  }
  disposer = {
    get: push('GET'),
    head: push('HEAD'),
    post: push('POST'),
    put: push('PUT'),
    patch: push('PATCH'),
    delete: push('DELETE'),
    options: push('OPTIONS'),
    on: (method, definition, handler) => {
      const upper = method.toUpperCase() as HttpMethod
      if (!SUPPORTED_METHODS.includes(upper))
        throw new TypeError(`defineRoutes: 不支持的方法 "${method}"（支持 ${SUPPORTED_METHODS.join(' / ')}）`)
      return push(upper)(definition, handler)
    },
  }
  return disposer
}

/** 按 (kind, path) 收敛：宿主对同一路径只允许一行注册，方法分发交给 h3 的路由表。 */
function groupRoutes(routes: readonly CollectedRoute[]): RouteGroup[] {
  const groups = new Map<string, { definition: RouteDefinition, methods: Set<HttpMethod> }>()
  for (const route of routes) {
    const key = `${route.definition.kind}\u0000${route.definition.path}`
    let group = groups.get(key)
    if (!group) {
      group = { definition: { ...route.definition }, methods: new Set<HttpMethod>() }
      groups.set(key, group)
    }
    group.methods.add(route.method)
  }
  return [...groups.values()]
}

/**
 * h3 路由模式由宿主路径 1:1 派生：exact 原样，prefix 追加 `/**` 通配尾段
 * （h3 文档：`/hello/**` 同时匹配 `/hello`、`/hello/world`、`/hello/world/123`）。
 */
function toH3Pattern(definition: RouteDefinition): string {
  return definition.kind === 'prefix' ? `${definition.path}/**` : definition.path
}

/** 一个路径行的宿主 handler：先做连接/方法/来源约束，再整包交给 h3。 */
function createHostHandler(connection: ConnectionGate | undefined, node: HostNodeHandler, group: RouteGroup): RouteHandler {
  const declared = group.methods
  const allowed = SUPPORTED_METHODS.filter(method =>
    method === 'OPTIONS'
    // 支持 GET 即隐含支持 HEAD（h3 会把 HEAD 自动匹配到 GET 路由），避免探测式 HEAD 被误判 405。
    || declared.has(method)
    || (method === 'HEAD' && declared.has('GET')))
  const allow = allowed.join(', ')

  return async (request, response) => {
    const rejection = connection?.requestRejection?.(request)
    if (rejection !== undefined) {
      respondJson(response, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
      return
    }

    const method = (request.method ?? 'GET').toUpperCase() as HttpMethod
    if (method === 'OPTIONS' && !declared.has('OPTIONS')) {
      response.writeHead(204, { allow })
      response.end()
      return
    }
    if (!allowed.includes(method)) {
      respondJson(response, 405, { error: `仅支持 ${allow} 请求` }, { allow })
      return
    }
    if (MUTATING_METHODS.has(method) && !isLoopback(request)) {
      respondJson(response, 403, { error: '变更操作仅限本机（127.0.0.1）调用' })
      return
    }
    // 回环地址挡不住「本机浏览器里的第三方页面」：CSRF / DNS rebinding 请求同样来自
    // 127.0.0.1。因此变更操作还要过一道来源校验——带 Origin 且与 Host 不符即拒绝。
    // 无 Origin 的非浏览器调用方（curl / 宿主内部）不受影响。
    if (MUTATING_METHODS.has(method) && isCrossOrigin(request)) {
      respondJson(response, 403, { error: 'cross-origin-request' })
      return
    }
    // 宿主 webserver 的 gzip 中间件（compression 1.8.1）与 srvx 的 node 适配器不兼容：srvx 用
    // `res.end(resolve)` 收尾，compression 的 res.end 垫片把函数当 chunk 交给 Buffer.from 抛
    // ERR_INVALID_ARG_TYPE，随后 destroy 连接——浏览器只看到 Failed to fetch。触发条件是响应体
    // ≥ 压缩阈值（1024B）且客户端接受 gzip。声明 no-transform 让压缩中间件不建流，回落到 Node
    // 原生 res.end(callback)：小于阈值的响应本就不压缩，故不损失任何实际启用过的压缩。只箍在
    // h3 这条路上——上面的守卫分支是自己写字符串的纯 Node 响应，没有函数收尾的问题。
    response.setHeader('cache-control', 'no-transform')
    await node(request, response)
  }
}

/** 回环判定（与宿主 webserver 的信任边界一致）。 */
function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 跨源判定：只在请求带 `Origin` 且其 host 与 `Host` 不符时判为跨源。
 *
 * 刻意不把「缺少 Origin」当跨源——那会让 curl / 宿主内部调用方（无浏览器语义）
 * 全部被拒；浏览器发起的跨源请求必定带 Origin，因此该判据足够收敛 CSRF 面。
 */
function isCrossOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined)
    return false
  try {
    return new URL(origin).host !== host
  }
  catch {
    // Origin 头存在但不可解析：按最坏情况拒绝。
    return true
  }
}

function respondJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(payload))
}
