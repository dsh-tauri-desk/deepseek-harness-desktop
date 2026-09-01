import type { ComponentType, ReactElement, ReactNode } from 'react'

/** panel.protocol 宿主服务（经 ctx.reflect.get 取用；完整类型见 dsh-tauri-panel/PROTOCOL.md）。 */
export interface PanelProtocol {
  /** 面板区条目组件：id/icon/onClick/children 由子插件填，其余宿主处理。 */
  ActionItem: (props: { id: string, icon?: ReactElement, onClick?: () => void, children?: ReactNode }) => ReactElement
  /** 切换会话区替换：未替换则打开 render，已替换则关闭恢复官方会话界面。 */
  renderPanelContent: (spec: { id: string, render: ComponentType<{ t?: (key: string) => string }>, locale?: string, side?: 'conversation' | 'details' }) => void
  /** 显式关闭当前面板内容并恢复官方会话界面。 */
  closePanelContent: () => void
  /** 程序化设置内容宽度（clamp 到契约范围并持久化）。（可选：老版本无此字段，消费方 `?.()` 探测。） */
  setPanelWidth?: (px: number) => void
  /** 清除宽度偏好，恢复自适应宽度。（可选，同上。） */
  resetPanelWidth?: () => void
  /** 当前内容宽度（含偏好；无面板挂载时返回偏好或 null）。（可选，同上。） */
  getPanelWidth?: () => number | null
  /** 透传 ctx.layout.openDetails：打开右侧 details 列。（可选，同上。） */
  openDetails?: () => void
  /** 透传 ctx.layout.closeDetails：关闭右侧 details 列。（可选，同上。） */
  closeDetails?: () => void
}

/** sidebar.panel.action 条目合成 props 子集（inject 提供 protocol）。 */
export interface PlaceholderPanelProps {
  /** 本条目 locale 翻译函数（placeholder NS）。 */
  t: (key: string) => string
  /** 宿主面板协议服务（inject：ctx.reflect.get('panel.protocol')）。 */
  protocol: PanelProtocol
}

export interface IconProps {
  className?: string
}
