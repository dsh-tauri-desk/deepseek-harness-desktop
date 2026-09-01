/**
 * lib/worktree.ts — 工作树客户端的纯函数（无 DOM、无 React、无副作用）。
 * 从 features/mode-select.tsx 与 session.ts 剥离，便于单测与复用。
 */

import type { SessionsRuntime, WorkspaceSessionOrder } from '../types'
import { SESSION_SWITCH_MAX_ATTEMPTS, SESSION_SWITCH_RETRY_DELAY_MS } from '../constants'

/**
 * 等待新工作树会话的输入服务就绪（新建会话发布与 Session scope 可寻址
 * 并非同一时刻；直接调 setDraft/submit 会因服务未就绪而静默失败）。
 */
export async function waitForInputActions(sessionsRuntime: SessionsRuntime, sessionId: string): Promise<import('../types').InputActions> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const actions = sessionsRuntime.provideInfo(sessionId)?.props?.inputActions
    if (actions)
      return actions
    await new Promise<void>(resolve => window.setTimeout(resolve, 100))
  }
  throw new Error('新工作树会话的输入服务尚未就绪')
}

/**
 * 从「访问模式」按钮向上找到官方输入条里的 `.modes` 分组（访问模式按钮 + 计划槽位所在行）。
 *
 * 官方 DOM（dsh 0.1.1-rc.x）：访问模式 `<Menu anchor={button}>` 没传 portal，`button`
 * 被包在 Menu root span 里，祖父才是 `.modes` 分组。直接把控件插到 button 右边会落进
 * Menu root span 内部（无 gap 且被计划槽位挤压）；必须定位到 `.modes` 容器本身。
 * `.modes` 是生成 CSS module hash（`.uV2eYG_modes`），不能依赖，故用语义判定：
 *   - 有 plan 槽位时，能容纳该 slot 的祖先即是 `.modes`（访问模式按钮与 plan slot 的公共父）。
 *   - 无 plan 槽位（alpha 变体）时退回「Menu root span 的父节点」。
 * 纯函数、不查 DOM：planSlot 由调用方按需传入。
 *
 * @param button 访问模式按钮（closest COMPOSER_MODE_BUTTON_SELECTOR）
 * @param planSlot 输入条内 plan 槽位节点，缺失时走第二规则
 * @param maxDepth 向上最多追溯层数（防御性上限，默认 8）
 * @returns 定位到的 `.modes` 分组节点；找不到时回退返回 button 本身（保证控件不消失）
 */
export function resolveAccessModeGroup(button: HTMLElement, planSlot: Element | null, maxDepth = 8): HTMLElement {
  let previous: HTMLElement = button
  let node: HTMLElement | null = button.parentElement
  for (let depth = 0; node && depth < maxDepth; depth++) {
    if (planSlot ? node.contains(planSlot) : previous !== button)
      return node
    previous = node
    node = node.parentElement
  }
  // graceful fallback：未知布局时把控件放在按钮自身之后，避免完整消失。
  return button
}

/**
 * 等待托管侧带 seed 创建的工作树会话进入客户端会话列表。
 *
 * 宿主侧 seed 创建的会话必须先经 session-added 帧（或 refreshList 兜底）进入客户端
 * list，provideInfo/create 才能寻址到它；直接用 create 会抛「已存在会话」或拿不到句柄。
 * 当 createWorktree 返回 inherited:true 时须走本函数代替 create。
 */
export async function waitForSessionListed(
  sessionsRuntime: SessionsRuntime,
  sessionId: string,
  attempts = SESSION_SWITCH_MAX_ATTEMPTS,
  delayMs = SESSION_SWITCH_RETRY_DELAY_MS,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (sessionsRuntime.list?.getSnapshot().ids.includes(sessionId))
      return
    await sessionsRuntime.refresh?.()
    await new Promise<void>(resolve => window.setTimeout(resolve, delayMs))
  }
  throw new Error('新工作树会话尚未就绪')
}

/** 返回目标工作区与当前首个其他会话，供检出会话插到工作区最上方。 */
export function resolveWorkspaceTopInsertion(
  workspaces: readonly WorkspaceSessionOrder[],
  projectPath: string,
  targetSessionId: string,
): { workspaceId: string, beforeSessionId?: string } | undefined {
  const workspace = workspaces.find(item => item.path === projectPath)
  if (!workspace)
    return undefined
  return {
    workspaceId: workspace.workspaceId,
    beforeSessionId: workspace.sessionIds.find(id => id !== targetSessionId),
  }
}
