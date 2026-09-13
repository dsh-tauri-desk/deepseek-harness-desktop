/**
 * client/types/index.ts — 客户端共享类型（宿主协议 + 行状态 + 运行时服务）。
 */

/** 编辑请求体（POST /message-tree）。 */
export interface EditRequest {
  sessionId: string
  /** 轮次（DOM 注入路径；与 eventSeq 二选一）。 */
  turn?: number
  /** 事件 seq（气泡 props 路径）。 */
  eventSeq?: number
  /** 改后的文本（宿主回显时用于日志，不参与边界计算）。 */
  text: string
}

/** 边界解析成功：该消息之前最后一个闭合回合的 turn/end seq。 */
export interface BoundaryOk {
  ok: true
  /** 宿主建好的截断子会话 id。 */
  childId: string
  /** 边界锚点（诊断用；首轮为 -1）。 */
  boundary: number
  turn: number
  eventSeq: number
  /** 首轮编辑：前缀为空，子会话只有系统提示。 */
  reset: boolean
}

/** 边界解析失败（首条消息 / 回合未闭合 / 找不到目标）。 */
export interface BoundaryFail {
  ok: false
  code: 'session-not-found' | 'invalid-target' | 'turn-open' | 'no-boundary'
  message: string
}

/** 编辑响应体（与 DSH-EasyRewrite 的 /bubble/recall 语义一致）。 */
export type EditResponse = BoundaryOk | BoundaryFail

/** 会话绑定（`ctx.sessions.binding(id)`）。 */
export interface SessionBinding {
  session?: {
    prompt?: (content: unknown, mode?: unknown) => Promise<unknown>
  }
}

/** 会话列表订阅快照（`ctx.sessions.list`）。 */
export interface SessionListSnapshot {
  current?: string
  byId: Record<string, { running?: boolean } | undefined>
}

/** 会话导航 / 列表 / fork 服务的最小契约。 */
export interface SessionsService {
  list?: {
    getSnapshot: () => SessionListSnapshot
    subscribe: (listener: () => void) => () => void
  }
  open: (sessionId: string) => void
  /** 官方截断边界器：child 进入会话列表并可打开。 */
  fork?: (options: { sessionId: string, atSeq: number }) => Promise<string>
  /** 新建会话（首轮 reset 路径用；workspaceId 与 cwd 互斥）。 */
  create?: (opts?: { workspaceId?: string, cwd?: string }) => Promise<string>
  binding?: (sessionId: string) => SessionBinding | undefined
}

/** 一个用户气泡行的注入状态。 */
export interface HostRowState {
  element: Element
  /** 是否处于编辑态。 */
  editing: boolean
  /** 官方气泡进入编辑前的 `display`，退出时逐字还原。 */
  bubbleDisplay: string
}
