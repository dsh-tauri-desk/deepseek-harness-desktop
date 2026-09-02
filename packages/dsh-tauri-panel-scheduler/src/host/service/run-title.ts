/**
 * host/service/run-title.ts — 定时执行 Session 的展示标题。
 *
 * 标题即任务名，不加时间前缀：时间信息已由面板执行记录与侧边栏行内时间列承载，
 * 侧边栏归属标记由客户端时钟图标负责（register/session-icons.ts，对齐
 * dsh-tauri-worktree 的会话行图标补丁）。
 */

export function schedulerSessionTitle(taskName: string): string {
  return taskName
}
