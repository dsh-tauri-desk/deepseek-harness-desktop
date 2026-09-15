/**
 * client/types/index.ts — 客户端跨模块共享的线协议与领域模型。
 *
 * 单一模块专属的类型与所属模块同目录同名（`store/modules/session.types.ts`、
 * `components/turn-changes-card.types.ts`…），此目录只留被多个模块共享的类型。
 */

/** 单文件变更状态：本 turn 新增 / 修改 / 删除。 */
export type TurnFileStatus = 'A' | 'M' | 'D'

/** 宿主 summary 路由返回的单文件差异。 */
export interface TurnFileChange {
  path: string
  status: TurnFileStatus
  insertions: number | null
  deletions: number | null
  binary: boolean
}

/** 宿主 summary 路由返回的单 turn 记录。 */
export interface TurnSummary {
  turn: number
  fileCount: number
  insertions: number
  deletions: number
  undoneAt: number | null
  unavailable: string | null
  /**
   * 该轮是否建立过快照基线（旧宿主不带该字段时视为 true，即保守地照常呈现）。
   * 与 `unavailable` 配合：连基线都没有的通用失败不弹告警（见 utils/format.ts）。
   */
  hasBaseline?: boolean
  truncated: boolean
  files: TurnFileChange[]
  /**
   * 因超过单文件上限而未纳入快照的路径（撤销不含它们）。
   * 宿主只回传前若干条（载荷有界），因此必须按「计数」而不是「长度」呈现。
   */
  skippedOversized: string[]
  /** 被跳过的嵌套仓库目录（gitlink 内容不受撤销保护）。 */
  skippedNestedRepos: string[]
}

/** 宿主 summary 路由的完整载荷。 */
export interface SessionSummary {
  sessionId: string
  isGit: boolean
  workspaceRoot: string | null
  unavailableReason: string | null
  turns: TurnSummary[]
}

/** 撤销请求的响应体（成功与失败共用，失败时 ok=false）。 */
export interface UndoResponse {
  ok?: boolean
  restored?: string[]
  removed?: string[]
  failed?: Array<{ path: string, reason: string }>
  error?: string
  conflicts?: Array<{ path: string, reason: string }>
}

/** 运行中实时读数（宿主 live 路由的载荷）。 */
export interface LiveSnapshot {
  /** 是否有正在进行的 turn。 */
  active: boolean
  turn: number | null
  fileCount: number
  insertions: number
  deletions: number
}

/** 撤销失败的冲突明细。 */
export interface UndoConflict {
  path: string
  reason: string
}

/** 卡片渲染用的判定结果（纯函数 `resolveCardState` 的输出）。 */
export type TurnCardState
  = | { kind: 'hidden' }
    | { kind: 'ready', record: TurnSummary }
    | { kind: 'undone', record: TurnSummary }
    | { kind: 'unavailable', reason: string | null }
    | { kind: 'failed', reason: string }

/** 界面文案键（zh 为权威键集，en 必须逐键对齐）。 */
export type LocaleKey
  = | 'fileButton'
    | 'editedOne'
    | 'editedMany'
    | 'undo'
    | 'undoing'
    | 'review'
    | 'viewChanges'
    | 'moreFiles'
    | 'collapseFiles'
    | 'undoneBadge'
    | 'runningChanged'
    | 'binary'
    | 'unavailableTitle'
    | 'unavailableReason'
    | 'undoFailed'
    | 'conflictTitle'
    | 'expiredReason'
    | 'gitUnavailableReason'
    | 'turnActiveReason'
    | 'snapshotFailedReason'
    | 'unsafePathReason'
    | 'skippedOversized'
    | 'skippedNestedRepos'
    | 'openFile'
