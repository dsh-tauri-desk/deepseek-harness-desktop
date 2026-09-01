/** types/protocol.ts — 扩展面板协议类型（panel.protocol 服务面 + 注入面）。 */

import type { ClientContext } from 'dsh-tauri/client'
import type { ComponentType, ReactElement, ReactNode } from 'react'

export interface IconProps {
  size?: number
  className?: string
}

export interface Translate {
  (key: string): string
}

export interface ExtensionLocaleService {
  register: (namespace: string, locale: string, dictionary: Record<string, string>) => () => void
  bind: (namespace: string) => Translate
}

export type ExtensionClientContext = ClientContext & { locale: ExtensionLocaleService }

export interface PanelContentSpec {
  id: string
  render: ComponentType<{ t?: Translate }>
  locale?: string
}

export interface PanelActionItemProps {
  id: string
  icon?: ReactElement
  onClick?: () => void
  children?: ReactNode
}

export interface PanelProtocol {
  ActionItem: (props: PanelActionItemProps) => ReactElement
  renderPanelContent: (spec: PanelContentSpec) => void
  closePanelContent: () => void
}
