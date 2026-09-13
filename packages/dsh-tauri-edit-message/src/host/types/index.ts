/**
 * host/types/index.ts — 宿主半区类型。
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
