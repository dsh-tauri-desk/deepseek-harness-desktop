/**
 * client/types/index.ts — 客户端共享类型（宿主协议 + 行状态 + 运行时服务）。
 */

/** 编辑请求体（POST /edit-message）。 */
export interface EditRequest {
  /** 操作类型：edit 改文本后重建；retry 原样重跑该轮。 */
  action: 'edit' | 'retry'
  sessionId: string
  /** 轮次（DOM 注入路径）。 */
  turn?: number
  /** 事件 seq（气泡 props 路径）。 */
  eventSeq?: number
  text: string
  /** 提交前停掉该家族里仍在生成的回合（与上游一致）。 */
  stopPrevious?: boolean
}

/** 编辑响应体。 */
export interface EditResponse {
  sessionId: string
}

/** 会话列表订阅快照（`ctx.sessions.list`）。 */
export interface SessionListSnapshot {
  current?: string
  byId: Record<string, { running?: boolean } | undefined>
}

/** 会话导航 / 列表服务的最小契约。 */
export interface SessionsService {
  list?: {
    getSnapshot: () => SessionListSnapshot
    subscribe: (listener: () => void) => () => void
  }
  open: (sessionId: string) => void
}

/** 一个用户气泡行的注入状态。 */
export interface HostRowState {
  element: Element
  /** 是否处于编辑态。 */
  editing: boolean
  /** 官方气泡进入编辑前的 `display`，退出时逐字还原。 */
  bubbleDisplay: string
}
