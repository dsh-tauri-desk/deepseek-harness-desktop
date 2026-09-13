/**
 * host/types/index.ts — 宿主半区类型（最小契约 + 版本家族树投影）。
 *
 * 宿主 ctx 的完整契约由运行时提供，这里只声明本插件真正调用的成员，避免复制
 * 会漂移的宽接口。
 */

/** 宿主根上下文（运行时注入；本插件只按需访问其中的服务）。 */
export type HostContext = any

/** 解析后的 JSON 请求体。 */
export type JsonBody = Record<string, unknown>

/** 会话事件的最小面（回合折叠只需要 type / seq / time / data）。 */
export interface SessionEventLike {
  seq: number
  type: string
  time: number
  data: Record<string, unknown>
  /** 插件自定义事件的投递标记；缺它读取端会拒绝解释整份日志。 */
  ignorable?: boolean
}

/** 会话头的最小面。 */
export interface SessionHeaderLike {
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  isSeeded?: boolean
  seedLength?: number
  agentPreset?: string
}

/** 会话记录（live 会话与查询快照归一后的稳定快照）。 */
export interface SessionRecordLike {
  id: string
  header: SessionHeaderLike
  events: readonly SessionEventLike[]
  inheritedEventCount: number
}

/** 一条已闭合回合。 */
export interface TurnLike {
  turn: number
  startSeq: number
  endSeq: number
  user?: SessionEventLike
}

/** 一次分支操作的规划结果（宿主内部）。 */
export interface EditPlanLike {
  /** 保留到（含）哪个事件 seq：`turn/start - 1`。 */
  boundary: number
  /** 写入新会话的版本标记事件载荷。 */
  version: Record<string, unknown>
  /** 排进新会话队列的用户消息（改后 / 原样）。 */
  queuedUsers: Array<Record<string, unknown>>
}

/** 客户端 POST /message-tree 的操作语义面。 */
export interface MessageOperationLike {
  action: 'edit' | 'retry'
  sessionId: string
  eventSeq?: number
  blockIndex?: number
  text?: string
  turn?: number
  stopPrevious?: boolean
}

/** 会话家族里的一条版本（‹ n/m › 与版本图的数据行）。 */
export interface VersionLike {
  sessionId: string
  parentSessionId?: string
  createdAt: number
  depth: number
  current: boolean
  onCurrentPath: boolean
  deleted?: boolean
  archived?: boolean
  operation?: string
  targetTurn?: number
  targetEventSeq?: number
  before?: string
  after?: string
  turns: Array<{ turn: number, text: string, time: number }>
}

/** 家族扁平化用的条目（含 ghost 墓碑）。 */
export interface VersionEntryLike {
  id: string
  parentId?: string
  createdAt: number
  ghost?: boolean
  marker?: Record<string, unknown>
}

/** 一次分支创建的响应。 */
export interface EditSessionResponse {
  sessionId: string
  queuedTurns: number[]
}

/** 版本图里的一个轮次节点（`buildTurnTree` 的输出）。 */
export interface TurnNode {
  id: string
  sessionId: string
  turn?: number
  parentId?: string
  isRoot?: boolean
  operation?: string
  text?: string
  time?: number
  current?: boolean
  onCurrentPath?: boolean
  deleted?: boolean
  archived?: boolean
}
