/**
 * dsh-tauri-worktree 客户端插件体（browser half）：会话级 Git Worktree 隔离的 UI。
 *
 * 四项 UI（全部 slot-shadow / DOM 补丁，零结构补丁，零新增运行时依赖）：
 *   - select.tsx   注册进 conversation.input.right：模式选择下拉框（本地/工作树）
 *     及内联的会话处理状态与创建日志（三阶段）。
 *   - surface.tsx   注册进 shell.overlay：工作树模式的常驻顶部提示条
 *     [ 该会话正在工作树进行 ] --- [ 检出本地 ] [ 放弃 ]。
 *   - dialog.tsx       注册进 shell.overlay：检出本地/放弃更改两个模态框。
 *   - session.ts   DOM 补丁：侧边栏会话行时间标识左侧的 Git 分支图标。
 *
 * 与 node half（src/index.ts）经 /api/dsh-worktree/* 通信（create/status/checkout/discard）。
 */
import type { ClientContext } from 'dsh-tauri/client'
import { compat } from 'dsh-tauri/client'
import {
  HYDRATION_EFFECT,
  SESSION_ICONS_EFFECT,
  STYLES_EFFECT,
  WORKTREE_PLUGIN_NAME,
} from './constants'
import { registerDialog } from './dialog'
import { installWorktreeHydration } from './hydrate'
import { installLocale } from './locale'
import { mountModeSelectStyles, registerModeSelect } from './select'
import { installSessionIcons } from './session'
import { mountWorktreeStyles } from './styles'
import { registerSurface } from './surface'

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
  registerModeSelect(cx)
  registerSurface(cx)
  registerDialog(cx)
  ctx.effect(() => installWorktreeHydration(cx), HYDRATION_EFFECT)
  ctx.effect(() => installSessionIcons(), SESSION_ICONS_EFFECT)
}
