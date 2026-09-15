import type { WorkspaceViewLike } from '../types/runtime'

/** 工作区菜单补丁捕获的归档目标（与克隆出的菜单条目一对一）。 */
export interface WorkspaceArchiveTarget {
  workspace: WorkspaceViewLike | undefined
  sessionIds: string[]
}
