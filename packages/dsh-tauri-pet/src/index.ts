/**
 * src/index.ts — dsh-tauri-pet 宿主侧（node half）。
 *
 * 方案 1（host → rust → pet webview）：宿主不再让 iframe 客户端对快照做差分
 * （#396 客户端根因），改为在宿主把 `session/event`【增量】总线状态化重建为桌宠
 * 展示态后，经 HTTP SSE 流发布；Rust 用 reqwest 订阅该流并 `emit_to('pet')`。
 *
 * 角色划分：
 *   - host/reducer.ts  纯函数「增量事件 → 桌宠展示态」reducer（单测覆盖）；
 *   - index.ts（本文件） 宿主装配：订阅 session/event + session/disposed + agent/status，
 *                        把变化经 reducer 投影后广播到 SSE 客户端（agent/status → idle
 *                        是「核心漏发 turn/end」的中断兜底，见 reducer.idle）；
 *   - Rust 消费端       新后台任务 reqwest GET 本 SSE 流 → emit_to
 *                        (pet_window::PET_WINDOW_LABEL, "session:*").
 *
 * 本文件是薄的适配层：把「宿主 session 到底有什么字段」这个无法本会话运行时
 * 验证的不确定性，隔离在 peerOf() 这一处（其余逻辑见 reducer.ts 的单测）。
 */

import type { HostContext, RouteHandler } from 'dsh-tauri'
import type { PetSessionEvent, PetSessionPayload, PetSessionPeer } from './host/reducer'
import { createPetSessionReducer } from './host/reducer'

/** 插件名（诊断元数据）。 */
export const name = 'dsh-tauri-pet'

/** 需要的宿主服务：webServer（SSE 路由）、sessions（session/event 总线）。 */
export const inject = ['webServer', 'sessions']

/** SSE 流路径（Rust 消费端按 `http://127.0.0.1:<DSH_WEB_PORT>` + 此路径订阅）。 */
export const SESSION_STREAM_PATH = '/api/dsh-pet/session-stream'

/** 从宿主 session / 事件读取会话 id（`peerOf` 复用，避免为取 id 重复推导整份 peer）。 */
function sessionIdOf(session: unknown, event: PetSessionEvent): string {
  const s = session as { id?: unknown, sessionId?: unknown } | undefined
  if (typeof s?.id === 'string')
    return s.id
  if (typeof s?.sessionId === 'string')
    return s.sessionId
  return String(event.data?.sessionId ?? '')
}

/**
 * 从宿主 session 对象读取的最小身份字段（运行时形状在此解耦，字段缺失即 undefined）。
 * 标题从宿主 `sessionTitle` 服务（`session/title` 事件折叠）读取 —— 裸 Session 类没有 title。
 *
 * `foldTitle` 只在**会话首次出现**时传入：`sessionTitle.get()` 内部是
 * `foldSessionTitle(session.snapshotEvents())`，而 `snapshotEvents()` 会整份复制
 * 会话事件日志（37k 事件 ≈ 288 KiB/次）再 `findLast` 扫描一遍 —— O(事件总数)。
 * 若在每次 `session/event`（含逐 token 的 assistant/chunk）都调用，宿主进程每 token
 * 都要付 1–4 ms CPU 与数百 KiB 垃圾，直接拖慢同进程的流式转发。后续标题变化由
 * reducer 的 `session/title` 分支增量带入，无需重复全量折叠。
 */
function peerOf(
  session: unknown,
  event: PetSessionEvent,
  foldTitle?: (session: unknown) => string | undefined,
): PetSessionPeer {
  const s = session as {
    id?: unknown
    sessionId?: unknown
    header?: { origin?: 'subagent', cwd?: string }
    summary?: {
      origin?: 'subagent'
      title?: string
      displayTitle?: string
      cwd?: string
      running?: boolean
    }
    title?: string
    displayTitle?: string
    cwd?: string
    running?: boolean
  } | undefined
  const id = sessionIdOf(session, event)
  const header = s?.header
  const summary = s?.summary
  const foldedTitle = foldTitle?.(session)
  const title = summary?.title ?? s?.title ?? foldedTitle
  return {
    id,
    origin: summary?.origin ?? header?.origin,
    title,
    displayTitle: summary?.displayTitle ?? s?.displayTitle ?? foldedTitle,
    cwd: summary?.cwd ?? header?.cwd ?? s?.cwd,
    running: typeof summary?.running === 'boolean' ? summary.running : s?.running,
  }
}

/** 把 bus 广播的事件归一化到 reducer 契约（丢弃无 data 载荷的 log-only 噪音由 reducer 兜底）。 */
function asPetEvent(event: unknown): PetSessionEvent {
  const e = event as Partial<PetSessionEvent> | undefined
  return {
    type: typeof e?.type === 'string' ? e.type : '',
    seq: typeof e?.seq === 'number' ? e.seq : 0,
    time: typeof e?.time === 'number' ? e.time : 0,
    data: (e?.data ?? {}) as Record<string, unknown>,
  }
}

/** `ctx.sessionProjections` 的最小读取面（只读本插件需要的 key，避免运行期依赖）。 */
interface ProjectionRegistryLike {
  stateOf?: (session: unknown, key: string) => unknown
}

/**
 * 插件体：订阅会话增量总线，经 reducer 投影后广播到 SSE 客户端。
 *
 * 消费模型（性能约定）：**没有 SSE 消费者就没有监听**。桌宠停用/隐藏后 Rust
 * 会主动断开订阅（`sync_pet_session_stream`），宿主侧最后一个客户端断开时注销
 * `session/event` + `session/disposed` 并丢弃累计态；下次有客户端接入再挂载。
 *
 * @param ctx - 宿主根上下文（注入 webServer / sessions）。
 */
export function apply(ctx: HostContext): void {
  // 已接入的 SSE 响应句柄（Rust 订阅者）。断连即移除。
  const clients = new Set<Parameters<RouteHandler>[1]>()
  // 会话出生：首次出现的 id 推 create，随后交由 apply() 推增量 update。
  const known = new Set<string>()

  // 会话标题折叠源：宿主 `sessionTitle` 服务（`session/title` 事件）。可选 —— 未挂载时回退 id。
  const titleService = ctx.get?.('sessionTitle') as
    | { get?: (session: unknown) => { title?: string } | undefined }
    | undefined

  // 投影注册表：`@deepseek-ai/dsh-session-title` 注册了 key='title' 的投影单元。
  // 惰性解析 —— apply() 时 registry 未必就绪（装配顺序不保证）。
  let projections: ProjectionRegistryLike | undefined
  /**
   * O(新事件) 读取当前标题：注册表按水位线增量推进每个单元的折叠，`stateOf`
   * 只补齐本会话尚未折叠的事件（每事件全局只折叠一次）。热路径用这个。
   */
  function projectedTitleOf(session: unknown): string | undefined {
    projections ??= ctx.get?.('sessionProjections') as ProjectionRegistryLike | undefined
    const title = projections?.stateOf?.(session, 'title')
    return typeof title === 'string' && title ? title : undefined
  }

  /**
   * 会话首次出现时的标题：优先投影；投影不可用（未装配 session-projection 或
   * key 未注册）才退化为 `sessionTitle.get()` —— 后者是 O(整份会话日志) 的
   * `foldSessionTitle(session.snapshotEvents())`，因此每个会话只允许调用一次。
   */
  function titleOnFirstSight(session: unknown): string | undefined {
    return projectedTitleOf(session) ?? titleService?.get?.(session)?.title
  }

  const reducer = createPetSessionReducer((action, payload) =>
    broadcast(action, payload))

  function broadcast(action: 'create' | 'update' | 'remove', payload: PetSessionPayload): void {
    for (const res of clients) {
      try {
        res.write(`data: ${JSON.stringify({ action, payload })}\n\n`)
      }
      catch {
        /* 断连写失败由 close 事件清理，忽略。 */
      }
    }
  }

  /** 会话事件监听的注销句柄；undefined = 当前无消费者、未挂载。 */
  let disposeSessionEvents: (() => void) | undefined

  function handleSessionEvent(session: unknown, event: unknown): void {
    const petEvent = asPetEvent(event)
    const id = sessionIdOf(session, petEvent)
    if (!id)
      return
    // 标题：首次出现走一次「投影 → 全量折叠」；此后只读 O(1) 投影（不可用时
    // 由 reducer 的 session/title 分支增量带入，绝不重新全量折叠）。
    const firstSight = !known.has(id)
    if (firstSight)
      known.add(id)
    const peer = firstSight
      ? peerOf(session, petEvent, titleOnFirstSight)
      : peerOf(session, petEvent, projectedTitleOf)
    if (firstSight)
      reducer.create(peer)
    reducer.apply(peer, petEvent)
  }

  function handleSessionDisposed(session: unknown): void {
    // remove 载荷只用 id：这里同样不折叠标题，避免销毁路径再付一次 O(日志) 成本。
    const peer = peerOf(session, { type: '', seq: 0, time: 0, data: {} })
    if (!peer.id)
      return
    known.delete(peer.id)
    reducer.remove(peer.id)
  }

  /**
   * agent 空闲兜底（`agent/status → idle`）：把「回合已收尾」这个事实传给 reducer，
   * 让核心漏发 `turn/end` 的中断（用户中止、被父级中断、异常收尾）也能回落空闲。
   * 载荷形状来自核心的 agent-scoped 事件（`agentEvents` 把 agent 融进 payload）：
   * `{ status, agent }`，会话 id 在 `agent.session.id`；与 turnrewind 宿主侧同一读取面。
   */
  function handleAgentStatus(payload: unknown): void {
    const event = payload as { status?: unknown, agent?: { session?: { id?: unknown } } } | undefined
    if (event?.status !== 'idle')
      return
    const id = event.agent?.session?.id
    if (typeof id !== 'string' || id.length === 0)
      return
    reducer.idle(id)
  }

  /** 首个消费者接入：挂载会话事件监听（幂等）。 */
  function attachSessionEvents(): void {
    if (disposeSessionEvents !== undefined)
      return
    const disposeEvent = ctx.on('session/event', handleSessionEvent) as () => void
    const disposeDisposed = ctx.on('session/disposed', handleSessionDisposed) as () => void
    // idle 兜底与 session/event 同生命周期：没有消费者时同样不订阅（热路径彻底退出）。
    const disposeStatus = ctx.on('agent/status', handleAgentStatus) as () => void
    disposeSessionEvents = () => {
      disposeEvent()
      disposeDisposed()
      disposeStatus()
    }
  }

  /** 最后一个消费者断开：注销监听并丢弃累计态，下次订阅从零重建。 */
  function detachSessionEvents(): void {
    if (disposeSessionEvents === undefined)
      return
    disposeSessionEvents()
    disposeSessionEvents = undefined
    reducer.clear()
    known.clear()
  }

  const sseHandler: RouteHandler = (request, response) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      // 本地环回流；开放给同源/桌宠窗口即可（后续可收口为 loopback 校验或 token）。
      'access-control-allow-origin': '*',
    })
    response.write('retry: 1000\n\n')
    clients.add(response)
    // 有消费者才开始监听会话总线（桌宠关闭时 Rust 不会连上来）。
    attachSessionEvents()
    // 心跳注释帧，防止代理/空闲断连。
    const ping = setInterval(() => {
      for (const res of clients) {
        try {
          res.write(': keepalive\n\n')
        }
        catch {
          /* ignore */
        }
      }
    }, 15_000)
    const onClose = () => {
      clients.delete(response)
      clearInterval(ping)
      // 无消费者：注销监听，热路径彻底退出（桌宠重新打开会自动重连并挂载）。
      if (clients.size === 0)
        detachSessionEvents()
      try {
        response.end()
      }
      catch {
        /* ignore */
      }
    }
    request.on('close', onClose)
    request.on('error', onClose)
  }

  // 路由注册 + 卸载清理。
  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: SESSION_STREAM_PATH,
      handler: sseHandler,
    })
    return () => {
      disposeRoute()
      detachSessionEvents()
      for (const res of clients) {
        try {
          res.end()
        }
        catch {
          /* ignore */
        }
      }
      clients.clear()
    }
  }, `${name}: session stream route`)
}
