import type { PetSessionPayload, SessionStreamSink } from '../types'
import type { PetSessionEvent, PetSessionPeer, ProjectionRegistryLike, TitleServiceLike } from './session-stream.types'
import { defineService } from 'dsh-tauri'
import {
  closeSessionBus,
  getCurrentHostInstance,
  isSessionBusAttached,
  knownSessions,
  setSessionBusDispose,
  sinks,
} from '../config/runtime'
import { createPetSessionReducer } from './session-stream.utils'

/**
 * service/session-stream.ts — 桌宠会话增量投影：订阅宿主会话总线，经 reducer 投影成
 * 桌宠展示态后广播给所有已接入的 SSE 消费者。
 *
 * 消费模型（性能约定）：**没有消费者就没有监听**。桌宠停用/隐藏后 Rust 会主动断开订阅，
 * 宿主侧最后一个消费者断开时注销 `session/event` + `session/disposed` + `agent/status`
 * 并丢弃累计态；下次有消费者接入再挂载。
 */

/** 会话总线 → 展示态帧的累计态机器（per-session Map 由 reducer 闭包持有）。 */
const reducer = createPetSessionReducer(publish)

export const sessionStream = defineService({
  /**
   * 接入一个 SSE 消费者：登记后（首个消费者时）挂载会话总线监听。
   *
   * @param sink - 该连接的推送/关闭出口。
   * @returns 断开该消费者的清理函数（幂等；最后一个消费者断开时注销总线监听并丢弃累计态）。
   */
  start(sink: SessionStreamSink): () => void {
    sinks.add(sink)
    attachSessionBus()
    return () => {
      sinks.delete(sink)
      if (sinks.size > 0)
        return
      closeSessionBus()
      reducer.clear()
    }
  },
})

// --- internal ---

/** 接入期解析出的宿主服务面（无消费者时清空，避免跨插件实例残留）。 */
let titleService: TitleServiceLike | undefined
let projections: ProjectionRegistryLike | undefined

/** 把一帧增量广播给全部消费者（写失败由各自的关闭回调清理）。 */
function publish(action: 'create' | 'update' | 'remove', payload: PetSessionPayload): void {
  const frame = JSON.stringify({ action, payload })
  for (const sink of sinks)
    sink.push(frame)
}

/** 首个消费者接入：解析宿主服务面并挂载会话事件监听（幂等）。 */
function attachSessionBus(): void {
  if (isSessionBusAttached())
    return
  // 惰性解析：apply 时服务未必就绪（装配顺序不保证），首个消费者接入时才读。
  const ctx = getCurrentHostInstance()
  titleService = ctx.get?.('sessionTitle') as TitleServiceLike | undefined
  projections = ctx.get?.('sessionProjections') as ProjectionRegistryLike | undefined
  const disposeEvent = ctx.on('session/event', handleSessionEvent) as () => void
  const disposeDisposed = ctx.on('session/disposed', handleSessionDisposed) as () => void
  // idle 兜底与 session/event 同生命周期：没有消费者时同样不订阅（热路径彻底退出）。
  const disposeStatus = ctx.on('agent/status', handleAgentStatus) as () => void
  setSessionBusDispose(() => {
    disposeEvent()
    disposeDisposed()
    disposeStatus()
    titleService = undefined
    projections = undefined
  })
}

/** 从宿主 session / 事件读取会话 id。 */
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
 *
 * `foldTitle` 只在**会话首次出现**时传入：`sessionTitle.get()` 内部是
 * `foldSessionTitle(session.snapshotEvents())` —— 整份会话事件日志 O(N) 复制 + 扫描，
 * 成熟会话单次 1–4 ms，跑在与流式转发同进程的 `append()` 同步发布路径上。
 * 若每次 `session/event`（含逐 token 的 assistant/chunk）都调用，宿主每 token 都要付
 * 这份 CPU 与垃圾；后续标题变化由 reducer 的 `session/title` 分支增量带入。
 */
function peerOf(
  session: unknown,
  event: PetSessionEvent,
  foldTitle?: (session: unknown) => string | undefined,
): PetSessionPeer {
  const s = session as {
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
  const header = s?.header
  const summary = s?.summary
  const foldedTitle = foldTitle?.(session)
  return {
    id: sessionIdOf(session, event),
    origin: summary?.origin ?? header?.origin,
    title: summary?.title ?? s?.title ?? foldedTitle,
    displayTitle: summary?.displayTitle ?? s?.displayTitle ?? foldedTitle,
    cwd: summary?.cwd ?? header?.cwd ?? s?.cwd,
    running: typeof summary?.running === 'boolean' ? summary.running : s?.running,
  }
}

/** 把 bus 广播的事件归一化到 reducer 契约。 */
function asPetEvent(event: unknown): PetSessionEvent {
  const e = event as Partial<PetSessionEvent> | undefined
  return {
    type: typeof e?.type === 'string' ? e.type : '',
    seq: typeof e?.seq === 'number' ? e.seq : 0,
    time: typeof e?.time === 'number' ? e.time : 0,
    data: (e?.data ?? {}) as Record<string, unknown>,
  }
}

/** O(新事件) 读取当前标题：注册表按水位线增量推进每个单元的折叠。 */
function projectedTitleOf(session: unknown): string | undefined {
  if (projections === undefined) {
    try {
      projections = getCurrentHostInstance().get?.('sessionProjections') as ProjectionRegistryLike | undefined
    }
    catch {
      return undefined
    }
  }
  const title = projections?.stateOf?.(session, 'title')
  return typeof title === 'string' && title ? title : undefined
}

/**
 * 会话首次出现时的标题：优先投影；投影不可用（未装配 session-projection 或 key 未注册）
 * 才退化为 `sessionTitle.get()` —— 后者是 O(整份会话日志) 的全量折叠，每个会话只允许一次。
 */
function titleOnFirstSight(session: unknown): string | undefined {
  return projectedTitleOf(session) ?? titleService?.get?.(session)?.title
}

function handleSessionEvent(session: unknown, event: unknown): void {
  const petEvent = asPetEvent(event)
  const id = sessionIdOf(session, petEvent)
  if (!id)
    return
  const firstSight = !knownSessions.has(id)
  if (firstSight)
    knownSessions.add(id)
  const peer = firstSight
    ? peerOf(session, petEvent, titleOnFirstSight)
    : peerOf(session, petEvent, projectedTitleOf)
  if (firstSight)
    reducer.create(peer)
  reducer.apply(peer, petEvent)
}

function handleSessionDisposed(session: unknown): void {
  // remove 载荷只用 id：销毁路径不折叠标题，避免再付一次 O(日志) 成本。
  const peer = peerOf(session, { type: '', seq: 0, time: 0, data: {} })
  if (!peer.id)
    return
  knownSessions.delete(peer.id)
  reducer.remove(peer.id)
}

/**
 * agent 空闲兜底（`agent/status → idle`）：把「回合已收尾」这个事实传给 reducer，
 * 让核心漏发 `turn/end` 的中断（用户中止、被父级中断、异常收尾）也能回落空闲。
 * 载荷形状来自核心的 agent-scoped 事件：`{ status, agent }`，会话 id 在 `agent.session.id`。
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
