import type { PanelProtocol, PlaceholderClientContext } from '../types'
import { Icon, IconPlaceholder } from 'dsh-tauri-ui/client'
import { Content } from '../components/content'
import {
  LOCALE_NAMESPACE,
  PANEL_ID,
  PANEL_LOCALE_KEY,
  PANEL_ORDER,
  PANEL_PROTOCOL_NAME,
  PANEL_SLOT_NAME,
  PLUGIN_ID,
} from '../constants'

/**
 * register/panel.tsx — 面板条目的槽位注册。
 *
 * 走 **官方全局面板协议**（0.1.5-rc.1 起）：`panel.protocol.registerPanel` 由宿主
 * 代注册 `sidebar.panellist`（入口行）+ `main`（内容）。本插件因此不再自己关心
 * 槽名，也不再需要「会话区替换」——面板的选中态由官方 `ctx.layout.selectPanel`
 * 统一派发。旧核心宿主由宿主内部回退到私有槽 + 会话区替换，本插件无感。
 * 完整契约见 dsh-tauri-panel/PROTOCOL.md。
 *
 * 就绪等待：沿用宿主私有槽 `sidebar.panel.action` 的声明作为「宿主已 apply」的
 * 门槛（该槽由 dsh-tauri-panel 的 sidebar 条目声明），比轮询定时器更确定。
 * @param ctx - 客户端根上下文。
 */
export function registerPanel(ctx: PlaceholderClientContext): void {
  ctx.slots.inject(PANEL_SLOT_NAME as never, () => {
    // 宿主协议服务经反射注册（dsh-tauri-panel apply 先于本条目声明执行）；
    // 缺失时降级：不注册条目（旧核心/宿主未装）。
    const protocol = ctx.reflect.get(PANEL_PROTOCOL_NAME) as PanelProtocol | undefined
    if (typeof protocol?.registerPanel !== 'function') {
      console.warn(`[${PLUGIN_ID}] ${PANEL_PROTOCOL_NAME}.registerPanel unavailable — panel item disabled.`)
      // 类型要求返回 SlotInjectionEffect：空 disposer 表示不注册任何条目。
      return () => {}
    }
    const t = ctx.locale.bind(LOCALE_NAMESPACE)
    return protocol.registerPanel({
      id: PANEL_ID,
      order: PANEL_ORDER,
      locale: LOCALE_NAMESPACE,
      label: () => t(PANEL_LOCALE_KEY),
      icon: <Icon as={IconPlaceholder} />,
      render: Content,
    })
  })
}
