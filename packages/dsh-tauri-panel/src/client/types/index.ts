import type { ComponentType, ReactElement, ReactNode } from 'react'

/** 侧栏槽 owner 传入的合成 props 子集。 */
export interface SidebarRootProps {
  /** 侧栏折叠态（layout 的 sidebarCol 状态）。 */
  collapsed: boolean
  /** 侧栏宽度（wide 态生效）。 */
  width: number
  /** 开始新会话（inject：ctx.workspaces.startSession）。 */
  startSession: (workspaceId?: string) => void
  /** 折叠/展开切换（inject：ctx.layout.toggleSidebar）。 */
  toggleSidebar: () => void
  /** 本条目 locale 翻译函数（panel NS）。 */
  t: (key: string) => string
}

/** 内容区替换规格（renderPanelContent 入参）。 */
export interface PanelContentSpec {
  /** 视图唯一标识（同一时刻只存在一个替换；active 态以它匹配 ActionItem）。 */
  id: string
  /** 视图组件：宿主渲染时按标准 kit 传入 t（可选，自包含组件可忽略）。 */
  render: ComponentType<{ t?: (key: string) => string }>
  /** 视图文案命名空间（可选，默认宿主 'panel'；视图可声明自己的 NS）。 */
  locale?: string
  /**
   * 承载侧（可选，缺省 conversation）：方案 B 预留字段。
   * 当前实现只处理 conversation（会话区替换）；`details`（右侧可拖拽列）
   * 为二期能力，本期不渲染，消费方调用时按 conversation 处理。
   */
  side?: 'conversation' | 'details'
}

/** panel.protocol 的稳定服务面。 */
export interface PanelProtocol {
  /** 面板区条目组件：样式、折叠态与 active 态由宿主承担。 */
  ActionItem: (props: PanelActionItemProps) => ReactElement
  /** 切换会话区替换：当前关闭则打开，当前打开则恢复会话。 */
  renderPanelContent: (spec: PanelContentSpec) => void
  /** 显式恢复官方会话区；用于面板内需要跳转到会话的动作。 */
  closePanelContent: () => void
  /**
   * 程序化设置内容宽度（clamp 到契约范围并持久化）。（可选：老版本协议
   * 对象无此字段，消费方一律 `?.()` 探测调用。）
   */
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

/** ActionItem 合成 props：id + 图标 + 点击行为 + 文字（子插件只填这些）。 */
export interface PanelActionItemProps {
  /** 条目唯一标识（active 态：当前内容区替换 id 与之相等则保持选中样式）。 */
  id: string
  /** 条目图标（16px 语义，自绘 SVG 组件实例）。 */
  icon?: ReactElement
  /** 点击行为：自定义动作；打开内容区替换典型写法是调 renderPanelContent。 */
  onClick?: () => void
  /** 条目文字（wide 态显示；折叠态宿主 CSS 自动隐藏，只留图标钮）。 */
  children?: ReactNode
}

/** 自绘 SVG 图标的通用 props。 */
export interface IconProps {
  size?: number
  className?: string
}
