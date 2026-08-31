import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type { PanelProtocol, PlaceholderPanelProps } from './types'
import {
  LOCALE_NAMESPACE,
  PANEL_ID,
  PANEL_LOCALE_KEY,
  PANEL_ORDER,
  PANEL_PRIORITY,
  PANEL_PROTOCOL_NAME,
  PANEL_SLOT_NAME,
  PLUGIN_ID,
} from './constants'
import { Content } from './content'
import { IconPlaceholder } from './icons'

/**
 * panel.tsx — 面板区（sidebar.panel.action 槽）样板条目：
 * 「定时任务」。按 dsh-tauri-panel 面板协议接入（见 ../dsh-tauri-panel/PROTOCOL.md）：
 * 条目用宿主导出的 <ActionItem> 组装（样式/折叠/active 态宿主承担），点击调
 * 宿主导出的 renderPanelContent 切换会话区替换——本插件零机制代码。
 */

function PlaceholderPanel(props: PlaceholderPanelProps): ReactElement {
  const { t, protocol: { ActionItem, renderPanelContent } } = props

  function onClick(): void {
    renderPanelContent({ id: PANEL_ID, render: Content, locale: LOCALE_NAMESPACE })
  }

  return (
    <ActionItem id={PANEL_ID} icon={<IconPlaceholder />} onClick={onClick}>
      {t(PANEL_LOCALE_KEY)}
    </ActionItem>
  )
}

/** 注册面板区样板条目（等 sidebar.panel.action 声明出现——即 dsh-tauri-panel 生效后）。 */
export function installPanel(ctx: Context): void {
  ctx.slots.inject(PANEL_SLOT_NAME as never, () => {
    // 宿主协议服务经反射注册（dsh-tauri-panel apply 先于本条目声明执行）；
    // 缺失时降级：不注册条目（旧核心/宿主未装）。
    const protocol = ctx.reflect.get(PANEL_PROTOCOL_NAME) as PanelProtocol | undefined
    if (!protocol) {
      console.warn(`[${PLUGIN_ID}] ${PANEL_PROTOCOL_NAME} host service unavailable — panel item disabled.`)
      // 类型要求返回 SlotInjectionEffect：空 disposer 表示不注册任何条目。
      return () => {}
    }
    return ctx.slots.register(
      {
        name: PANEL_SLOT_NAME,
        id: PLUGIN_ID,
        order: PANEL_ORDER,
        priority: PANEL_PRIORITY,
        locale: LOCALE_NAMESPACE,
        inject: () => ({ protocol }),
      } as never,
      PlaceholderPanel,
    )
  })
}
