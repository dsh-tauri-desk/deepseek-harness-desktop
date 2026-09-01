/**
 * dsh-tauri-worktree 客户端插件体（browser half）：会话级 Git Worktree 隔离的 UI。
 *
 * 四项 UI（全部 slot-shadow / DOM 补丁，零结构补丁，零新增运行时依赖）：
 *   - features/mode-select.tsx  注册进 conversation.input.right：模式选择下拉框（本地/工作树）
 *     及内联的会话处理状态与创建日志（三阶段）。
 *   - features/surface.tsx      注册进 shell.overlay：工作树模式的常驻顶部提示条
 *     [ 该会话正在工作树进行 ] --- [ 检出本地 ] [ 放弃 ]。
 *   - features/dialog.tsx       注册进 shell.overlay：检出本地/放弃更改两个模态框。
 *   - session.ts                DOM 补丁：侧边栏会话行时间标识左侧的 Git 分支图标。
 *
 * 目录规划：rpc.ts（ofetch 客户端）/ store.ts（共享状态 + unstorage 偏好）/
 * hydration.ts（状态恢复）/ controller 由 dsh-tauri/client 共享提供（hookable）。
 * 与 node half（host/）经 /api/dsh-worktree/* 通信（create/status/checkout/discard）。
 */
import type { ClientContext } from 'dsh-tauri/client'
import { compat } from 'dsh-tauri/client'
import {
  HYDRATION_EFFECT,
  MODE_SELECT_EFFECT,
  SESSION_ICONS_EFFECT,
  STYLES_EFFECT,
  SURFACE_EFFECT,
  WORKTREE_PLUGIN_NAME,
} from './constants'
import { registerDialog } from './features/dialog'
import { mountModeSelectStyles, registerModeSelect } from './features/mode-select'
import { registerSurface } from './features/surface'
import { installWorktreeHydration } from './hydration'
import { installLocale } from './locale'
import { installSessionIcons } from './session'
import { hydratePreferredMode } from './store'
import { mountWorktreeStyles } from './styles'

export { WORKTREE_API_PREFIX } from '../shared/constants'
export type * from './types'

/** 插件显示名（诊断元数据）。 */
export const name = WORKTREE_PLUGIN_NAME

/** 需要的客户端服务：slots（注册点位）、layout（面板）、locale（双语）、sessions（会话行匹配）。 */
export const inject = ['slots', 'layout', 'locale', 'sessions', 'workspaces']

/**
 * 插件体：安装文案并注册四项 UI。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const cx = compat(ctx)
  installLocale(cx)
  // 新会话偏好（本地/工作树）异步读回一次，未就绪前保持官方默认「本地」。
  void hydratePreferredMode()
  ctx.effect(
    () => {
      const unmountModeSelectStyles = mountModeSelectStyles()
      const unmountWorktreeStyles = mountWorktreeStyles()
      return () => {
        unmountModeSelectStyles()
        unmountWorktreeStyles()
      }
    },
    STYLES_EFFECT,
  )
  // 槽位注册统一走 ctx.effect：插件卸载时 inject 句柄随之释放（与 dialog 的 DIALOG_EFFECT 一致）。
  ctx.effect(() => registerModeSelect(cx), MODE_SELECT_EFFECT)
  ctx.effect(() => registerSurface(cx), SURFACE_EFFECT)
  registerDialog(cx)
  ctx.effect(() => installWorktreeHydration(cx), HYDRATION_EFFECT)
  ctx.effect(() => installSessionIcons(), SESSION_ICONS_EFFECT)
}
