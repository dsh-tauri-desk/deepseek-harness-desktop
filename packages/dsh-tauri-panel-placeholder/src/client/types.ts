import type { ComponentType, ReactElement, ReactNode } from 'react'

/** panel.protocol 宿主服务（经 ctx.reflect.get 取用；完整类型见 dsh-tauri-panel/PROTOCOL.md）。 */
export interface PanelProtocol {
  /** 面板区条目组件：id/icon/onClick/children 由子插件填，其余宿主处理。 */
  ActionItem: (props: { id: string, icon?: ReactElement, onClick?: () => void, children?: ReactNode }) => ReactElement
  /** 切换会话区替换：未替换则打开 render，已替换则关闭恢复官方会话界面。 */
  renderPanelContent: (spec: { id: string, render: ComponentType<{ t?: (key: string) => string }>, locale?: string }) => void
  /** 显式关闭当前面板内容并恢复官方会话界面。 */
  closePanelContent: () => void
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
