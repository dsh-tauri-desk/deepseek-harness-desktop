import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
/**
 * dsh-tauri-panel 客户端插件体（browser half）：工作区上方面板 UI。
 *
 * 能力（全部 slot-shadow，零结构补丁，零新增依赖）：
 *   整槽替换 sidebar（priority -1 shadow 官方 ui-sidebar）：克隆
 *   SidebarRoot —— 紧凑 logoRow（32px、底距 4px）、面板区（新会话菜单项
 *   + 协议槽 sidebar.panel.action 的第三方功能项）、官方子槽（workspaces/
 *   settings/footer/brand）经 <SlotOutlet> 透传。
 *
 * 协议：第三方插件向面板区添加功能项 = 注册 `sidebar.panel.action`
 * （list/root，本插件声明），详见 PROTOCOL.md。
 *
 * 依赖：renderer 补丁导出的 <SlotOutlet>（任意槽渲染入口）。核心未带补丁时
 * （旧安装）SlotOutlet 为 undefined —— 此时整体不注册（官方侧栏原样工作），
 * 绝不白屏。
 */
import type { ClientContext } from 'dsh-tauri/client'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
import { installPanelLocale } from './locale'
import { installPanelService } from './service'
import { installSidebarRoot } from './sidebar'
import { mountPanelStyles } from './styles'

export { PANEL_PROTOCOL_SERVICE } from './constants'
export type { IconProps } from './icons'
export type { PanelActionItemProps, PanelContentSpec, SidebarRootProps } from './types'

/** 插件显示名（诊断元数据）。 */
export const name = 'dsh-tauri-panel'

/**
 * 需要的客户端服务：slots（注册点位）、layout（折叠/宽度）、locale（双语文案）。
 *
 * `workspaces` 不能列为强制注入：Alpha 将会话导航放在 `uiWorkspace`，而
 * rc.2 才把 `startSession` 暴露在 `workspaces` 上。运行时差异由 compat(ctx)
 * 在 apply 内探测，避免 Alpha 在执行 apply 前因缺少 workspaces 而被 Cordis 跳过。
 */
export const inject = ['slots', 'layout', 'locale']

/**
 * 插件体：注册面板侧栏（整槽替换）。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => mountPanelStyles(),
    'dsh-tauri-panel: styles',
  )
  installPanelLocale(ctx)
  // 面板协议宿主服务（panel.protocol：ActionItem + renderPanelContent）：
  // 只走 slots runtime，不依赖 renderer 补丁——无补丁时内容区替换仍可用。
  installPanelService(ctx)

  // 侧栏面板依赖 renderer 补丁导出的 <SlotOutlet>；无补丁时不注册任何条目，
  // 官方侧栏原样工作。
  if (typeof SlotOutlet !== 'function') {
    console.warn(
      '[dsh-tauri-panel] <SlotOutlet> unavailable (renderer patch missing) — panel sidebar disabled, official UI stays.',
    )
    return
  }

  installSidebarRoot(ctx)
}
