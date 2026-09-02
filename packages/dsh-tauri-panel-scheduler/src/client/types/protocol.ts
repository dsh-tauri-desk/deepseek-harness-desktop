/**
 * types/protocol.ts — 面板协议类型（panel.protocol 服务面 + 注入面）。
 */

import type { ClientContext } from 'dsh-tauri/client'
import type { ComponentType, ReactElement, ReactNode } from 'react'

export interface IconProps {
  size?: number
  className?: string
}

export interface Translate {
  (key: string): string
}

/** 带参数插值的翻译函数（照搬 dsh-automation 的 ModelTranslate；{name} 形式）。 */
export interface ModelTranslate {
  (key: string, params?: Record<string, unknown>): string
}

export interface SchedulerLocaleService {
  register: (namespace: string, locale: string, dictionary: Record<string, string>) => () => void
  bind: (namespace: string) => Translate
}

export type SchedulerClientContext = ClientContext & { locale: SchedulerLocaleService }

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
