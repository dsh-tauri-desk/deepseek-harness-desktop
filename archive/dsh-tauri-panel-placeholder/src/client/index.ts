import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
/**
 * dsh-tauri-panel-placeholder 客户端插件体（browser half）：panel 协议样板。
 *
 * 作为 [dsh-tauri-panel 协议](./PROTOCOL.md) 的最小参考实现：
 *   - 面板入口「占位符」经 `panel.protocol.registerPanel` 一次性注册——由宿主
 *     按核心版本择路（新核心代注册官方 `sidebar.panellist` + `main`，旧核心回退
 *     私有槽 + 会话区替换）；
 *   - 面板本体为居中占位「自定义内容区」，**自包含**（不依赖 props）。
 *
 * 无业务逻辑：样板只演示协议接入点与「全局面板」的最小形态。
 */
import type { PlaceholderClientContext } from './types'
import { mountStyle } from 'dsh-tauri-ui/client'
import { PLUGIN_ID, STYLE_ID } from './constants'
import { registerPanelLocale } from './locales'
import { registerPanel } from './register/panel'
import placeholderStyle from './styles/index.cssr'

/** 插件显示名（诊断元数据）。 */
export const name = PLUGIN_ID

/** 需要的客户端服务：slots（协议就绪门槛）、locale（双语文案）。 */
export const inject = ['slots', 'locale']

/**
 * 插件体：注册面板入口与会话区替换。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: PlaceholderClientContext): void {
  ctx.effect(
    () => mountStyle(placeholderStyle, STYLE_ID),
    `${PLUGIN_ID}: styles`,
  )
  registerPanelLocale(ctx)
  registerPanel(ctx)
}
