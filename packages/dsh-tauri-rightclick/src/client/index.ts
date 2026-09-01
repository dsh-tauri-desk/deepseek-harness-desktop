/**
 * dsh-tauri-rightclick 客户端插件体（browser half）：原生风格的完整右键菜单。
 *
 * 按目标组装菜单（全部为稳定的无障碍语义 + 零结构补丁，无 React 组件、无运行时
 * 依赖）：
 *   - 会话行：官方重命名/归档/分叉转交官方组件；插件补充资源管理器打开目录、复制目录/会话 ID；
 *   - 工作区行：新建会话、打开目录、官方重命名、复制路径、归档工作区；
 *   - 未分组行：归档全部未分组正式会话、刷新；临时新会话不处理；
 *   - 可编辑元素：撤销/重做/剪切/复制/粘贴/全选；
 *   - 对话正文/设置页：复制所选文本、默认浏览器打开链接、全选当前内容；
 *   - 所有菜单：刷新。
 *
 * 与 node half（src/index.ts）经 /api/dsh-rightclick-menu/* 通信（open-url）。
 */
import type { ClientContext } from 'dsh-tauri/client'
import { compat } from 'dsh-tauri/client'
import {
  RIGHTCLICK_CLIENT_PLUGIN,
  RIGHTCLICK_MENU_EFFECT,
  RIGHTCLICK_STYLES_EFFECT,
} from './constants'
import { installLocale } from './locales'
import { installContextMenu } from './service/menu'
import { mountRightClickStyles } from './styles'

/** 插件显示名（诊断元数据）。 */
export const name = RIGHTCLICK_CLIENT_PLUGIN

/** 需要的客户端服务：locale（双语文案）、sessions（会话行匹配）、workspaces（工作区操作）。 */
export const inject = ['locale', 'sessions', 'workspaces']

/**
 * 插件体：安装文案与样式，并挂载右键菜单监听。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const cx = compat(ctx)
  installLocale(cx)

  ctx.effect(() => mountRightClickStyles(), RIGHTCLICK_STYLES_EFFECT)

  ctx.effect(() => installContextMenu(cx), RIGHTCLICK_MENU_EFFECT)
}
