import type { ReactElement } from 'react'
import type { PlaceholderPanelProps } from '../types'
import { LOCALE_NAMESPACE, PANEL_ID, PANEL_LOCALE_KEY } from '../constants'
import { Content } from './content'
import { IconPlaceholder } from './icons'

/**
 * components/panel.tsx — 面板区（sidebar.panel.action 槽）样板条目组件：
 * 「定时任务」。槽位注册在 register/panel.ts（installPanel）。
 */

export function PlaceholderPanel(props: PlaceholderPanelProps): ReactElement {
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
