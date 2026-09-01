/**
 * client/index.ts — 归档管理客户端装配入口。
 *
 * 只做 import + 组装（locale / styles / 分区注册 / 工作区补丁）；无业务实现。
 * 结构分层见 AGENTS.md：types/ lib/ dom/ components/ register/ 各司其职。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { compat } from 'dsh-tauri/client'
import { SESSION_ARCHIVE_PATCH_EFFECT, SESSION_STYLES_EFFECT } from './constants'
import { installWorkspaceArchivePatch } from './dom/workspace-patch'
import { installLocale } from './locales'
import { registerArchiveSection } from './register/archive-section'
import { mountSessionStyles } from './styles'

/** 插件显示名（诊断元数据）。 */
export const name = 'dsh-tauri-session'

/** 需要的客户端服务：slots / locale / sessions / workspaces。 */
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

/**
 * 插件体：安装文案与样式，注册「归档」设置分区，并安装工作区浏览器补丁。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const cx = compat(ctx)
  installLocale(cx)

  ctx.effect(() => mountSessionStyles(), SESSION_STYLES_EFFECT)

  // 1) 设置页「归档」分区（settings.section 单槽注册；导航行/内容由官方设置侧边栏投影）。
  registerArchiveSection(cx)

  // 2) 工作区浏览器补丁：替换「删除工作区」+ 隐藏归档会话行。
  ctx.effect(() => installWorkspaceArchivePatch(cx.workspaces as unknown as import('./types').WorkspacesRuntimeLike, cx.sessions as unknown as import('./types').SessionsRuntimeLike), SESSION_ARCHIVE_PATCH_EFFECT)
}
