import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
/**
 * dsh-tauri-panel-placeholder 客户端插件体（browser half）：panel 协议样板。
 *
 * 作为 [dsh-tauri-panel 协议](./PROTOCOL.md)（槽 sidebar.panel.action）的
 * 最小参考实现：
 *   - 面板区条目「定时任务」（复用 dsh-tauri-panel 全局注入的 dshp-menuItem
 *     行样式，wide 显示图标+文字 / 折叠只显示图标钮）；
 *   - 点击条目 → conversation 槽以 priority -1 **动态注册**（layout 声明的
 *     single/session-maybe 槽，官方 ui-conversation priority 0 是唯一注册者），
 *     整个右侧会话区替换为居中「自定义内容区」；关闭（再点条目 toggle 或
 *     点侧栏任意处）→ 注销条目，官方会话界面恢复。
 *
 * 无业务逻辑：样板只演示协议接入点与「会话区替换」的最小形态。
 */
import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from './constants'
import { installPanelLocale } from './locale'
import { installPanel } from './panel'
import { mountPlaceholderStyles } from './styles'

/** 插件显示名（诊断元数据）。 */
export const name = PLUGIN_ID

/** 需要的客户端服务：slots（注册点位）、locale（双语文案）。 */
export const inject = ['slots', 'locale']

/**
 * 插件体：注册面板区条目与会话区替换。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => mountPlaceholderStyles(),
    `${PLUGIN_ID}: styles`,
  )
  installPanelLocale(ctx)
  installPanel(ctx)
}
