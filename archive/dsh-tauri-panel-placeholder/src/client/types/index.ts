import type { ClientContext } from 'dsh-tauri/client'
import type { ComponentType, ReactElement, ReactNode } from 'react'

/**
 * types/index.ts — 本插件类型（样板插件只用到协议面与 locale bind 扩展）。
 */

/** 占位符面板自用的翻译函数。 */
export interface Translate {
  (key: string): string
}

/**
 * locale 服务的 bind 表面（真实运行时经 dsh-client-locale 提供）：
 * 面板入口文案由宿主在 thunk 里读时求值，因此需要一个 React 之外可用的 t。
 */
export interface PlaceholderLocaleService {
  register: (namespace: string, locale: string, dictionary: Record<string, string>) => () => void
  bind: (namespace: string) => Translate
}

export type PlaceholderClientContext = ClientContext & { locale: PlaceholderLocaleService }

/**
 * panel.protocol 的一次性面板注册入参（宿主按核心版本代注册官方全局面板）。
 * 完整契约见 dsh-tauri-panel/PROTOCOL.md。
 */
export interface PanelRegistration {
  /** 面板唯一标识；同时用作 `main` 的 key。 */
  id: string
  /** 展示文案；thunk 读时求值，跟随语言切换而无需重新注册。 */
  label: string | (() => string)
  /** 面板本体。 */
  render: ComponentType<{ t?: Translate }>
  /** 面板本体文案命名空间。 */
  locale?: string
  /** 条目图标。 */
  icon?: ReactElement
  /** 清单排序位，升序。 */
  order?: number
}

/** panel.protocol 宿主服务（经 ctx.reflect.get 取用；完整类型见 dsh-tauri-panel/PROTOCOL.md）。 */
export interface PanelProtocol {
  /** 面板区条目组件：id/icon/onClick/children 由子插件填，其余宿主处理。 */
  ActionItem: (props: { id: string, icon?: ReactElement, onClick?: () => void, children?: ReactNode }) => ReactElement
  /** 切换会话区替换：未替换则打开 render，已替换则关闭恢复官方会话界面。 */
  renderPanelContent: (spec: { id: string, render: ComponentType<{ t?: Translate }>, locale?: string, side?: 'conversation' | 'details' }) => void
  /** 显式关闭当前面板内容并恢复官方会话界面。 */
  closePanelContent: () => void
  /**
   * 注册一个全局面板（图标 + 内容），返回注销句柄。
   * （可选：老版本宿主无此字段，消费方探测后再用。）
   */
  registerPanel?: (entry: PanelRegistration) => () => void
  /** 程序化设置内容宽度（clamp 到契约范围并持久化）。（可选：老版本无此字段。） */
  setPanelWidth?: (px: number) => void
  /** 清除宽度偏好，恢复自适应宽度。（可选，同上。） */
  resetPanelWidth?: () => void
  /** 当前内容宽度（含偏好；无面板挂载时返回偏好或 null）。（可选，同上。） */
  getPanelWidth?: () => number | null
  /** 透传 ctx.layout.openDetails：打开右侧 details 列。（可选，同上。） */
  openDetails?: () => void
  /** 透传 ctx.layout.closeDetails：关闭右侧 details 列。（可选，同上。） */
  closeDetails?: () => void
  /** ≥0.1.5-rc.1：报告右侧栏占不占 track / 是否全屏。（可选，同上。） */
  openRightPanel?: (track: boolean, fullscreen: boolean) => void
  /** ≥0.1.5-rc.1：报告右侧栏隐藏。（可选，同上。） */
  closeRightPanel?: () => void
}

export interface IconProps {
  className?: string
}
