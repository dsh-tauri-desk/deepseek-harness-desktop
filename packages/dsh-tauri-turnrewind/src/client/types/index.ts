/**
 * client/types/index.ts — 客户端共享类型（宿主协议投影 + 卡片状态 + 组件 props）。
 */

import type { FileOpener } from '../utils/open-file'

export type { FileOpener } from '../utils/open-file'

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
   * 该轮是否建立过快照基线（旧内核/旧宿主不带该字段时视为 true，即保守地照常呈现）。
   * 与 `unavailable` 配合：连基线都没有的通用失败不弹告警（见 utils/format.ts）。
   */
  hasBaseline?: boolean
  truncated: boolean
  files: TurnFileChange[]
  /**
   * 因超过单文件上限而未纳入快照的路径（撤销不含它们）。
   * 宿主只回传前若干条（载荷有界），因此这里必须按「计数」而不是「长度」呈现。
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

/** 每会话客户端状态。 */
export interface TurnrewindSessionState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  summary: SessionSummary | null
  error: string | null
  /** 已发起的「该轮无记录」强制重试次数，按 turn 计数。 */
  attempts: Record<number, number>
  /** 撤销进行中。 */
  undoing: boolean
  /** 撤销失败提示（含冲突清单）。 */
  undoError: string | null
  undoConflicts: Array<{ path: string, reason: string }>
}

/** 模块级共享状态。 */
export interface TurnrewindUiState {
  bySession: Record<string, TurnrewindSessionState>
}

/** 卡片渲染用的判定结果（纯函数 `resolveCardState` 的输出）。 */
export type TurnCardState
  = | { kind: 'hidden' }
    | { kind: 'ready', record: TurnSummary }
    | { kind: 'undone', record: TurnSummary }
    | { kind: 'git-required' }
    | { kind: 'unavailable', reason: string | null }
    | { kind: 'failed', reason: string }

/** turnTail chain 的 owner props（框架派发；用到 turn 号与文件打开回调）。 */
export interface TurnTailOwnerProps {
  turn?: { turn?: number } | undefined
  seq?: number | undefined
  /**
   * 框架提供的文件打开入口（相对路径按会话 cwd 解析）。**两个内核都派发它，但语义不同**：
   * `0.1.5-rc.1` 在应用内右侧边栏打开预览页签，`0.1.2-rc.1` 交给宿主/系统打开该路径。
   * 因此本插件只在**探测到右侧边栏能力**时才调用（见 client/capabilities 与
   * client/utils/open-file.ts），旧内核上保持静默。
   */
  openFile?: FileOpener | undefined
}

/** 卡片组件收到的完整 props：owner 份额 + chain `matched` + 注册 inject 份额。 */
export interface TurnChangesCardProps extends TurnTailOwnerProps {
  matched?: { turn: number } | undefined
  sessionId?: string | undefined
}

/**
 * 运行中提示条 props：input.dock 的 owner 份额（InputZone）+ 注册 inject 份额。
 * owner 份额里的 `session` 是点快照的会话快照，`running` 决定是否轮询实时读数。
 */
export interface RunningChangesChipProps {
  session?: { running?: boolean } | undefined
  sessionId?: string | undefined
}

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
    | 'unavailableGitDesc'
    | 'unavailableReason'
    | 'undoFailed'
    | 'conflictTitle'
    | 'gitRequiredTitle'
    | 'gitRequiredDesc'
    | 'close'
    | 'expiredReason'
    | 'gitUnavailableReason'
    | 'turnActiveReason'
    | 'snapshotFailedReason'
    | 'unsafePathReason'
    | 'skippedOversized'
    | 'skippedNestedRepos'
    | 'openFile'
