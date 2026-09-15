import type { SessionsRuntimeLike, WorkspacesRuntimeLike } from '../types/runtime'

/** 合并宿主元数据与会话/工作区运行时事实后的一行归档记录。 */
export interface ArchiveRow {
  sessionId: string
  title: string
  cwd?: string
  createdAt?: number
  updatedAt?: number
  /** 展示所属工作区；undefined 表示「未分组」。 */
  workspaceId?: string
  workspaceTitle?: string
}

/** 分组后的归档行；未分组桶的 id 为 `ungrouped`。 */
export interface ArchiveGroupRow {
  id: string
  /** 工作区标题；未分组桶传 ''（由组件填当前语言的「未分组」文案）。 */
  title: string
  rows: ArchiveRow[]
}

/** 注入到 settings.section 槽位组件的 props。 */
export interface ArchivePanelProps {
  close?: () => void
  sessionsRuntime: SessionsRuntimeLike
  workspacesRuntime: WorkspacesRuntimeLike
}

export interface ArchiveWorkspaceDialogProps {
  workspaceTitle: string
  sessionIds: readonly string[]
  onClose: () => void
  onConfirm: () => void
}

/** 打开的删除确认弹窗：null 关闭。 */
export type DeleteConfirm
  = | null
    | { kind: 'single', sessionId: string }
    | { kind: 'all' }
    | { kind: 'workspace', workspaceTitle: string, sessionIds: string[] }
