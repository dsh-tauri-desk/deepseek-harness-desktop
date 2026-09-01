/**
 * components/action-item.tsx — 面板区条目（样式/折叠/active 态全宿主，
 * 子插件只填内容与行为）。
 *
 * 纯展示组件：active 态经 usePanelViewId 订阅替换状态。
 */

import type { ReactElement } from 'react'
import type { PanelActionItemProps } from '../types'
import { PANEL_CLASSES, PANEL_DATA_ATTRIBUTES } from '../constants'
import { usePanelViewId } from '../hooks/panel'

export function PanelActionItem({ id, icon, onClick, children }: PanelActionItemProps): ReactElement {
  const active = usePanelViewId()?.id === id
  return (
    <button
      type="button"
      className={active ? `${PANEL_CLASSES.menuItem} ${PANEL_CLASSES.menuItemSelected}` : PANEL_CLASSES.menuItem}
      {...{ [PANEL_DATA_ATTRIBUTES.action]: '' }}
      onClick={onClick}
    >
      {icon !== undefined && <span className={PANEL_CLASSES.menuItemIcon}>{icon}</span>}
      <span className={PANEL_CLASSES.menuItemLabel}>{children}</span>
    </button>
  )
}
