/**
 * constants/width.ts — 面板内容区宽度拖拽契约（方案 A，镜像 alpha
 * dsh-client-ui-conversation ConversationRoot 的宽度协议）。
 *
 * 与官方共用同一 localStorage 键与 CSS 变量（有意产品一致行为）：面板宽度
 * 与官方对话宽度偏好互通；官方未来若导出 WidthHandle 可平滑替换自绘手柄。
 */

/** localStorage 键：拖拽宽度偏好（px，与官方共用，见 alpha WIDTH_PREF_KEY）。 */
export const PANEL_WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'

/** 拖拽内容宽度下限（px），与 alpha CONTENT_MIN 一致。 */
export const PANEL_CONTENT_MIN = 640

/** 列两侧留给手柄的预算（px）：88px×2 = 24 inset + 40 strip + 24 safe zone。 */
export const PANEL_CONTENT_EDGE_BUDGET = 176

/** rc.2 时代固定回退宽度（px）；无偏好且不支持自适应时的兜底。 */
export const PANEL_CONTENT_DEFAULT = 780

/** 无偏好时的自适应 clamp 下界（px），与 alpha CSS clamp(680px,…) 一致。 */
export const PANEL_CONTENT_ADAPTIVE_MIN = 680

/** 无偏好时的自适应 clamp 上界（px），与 alpha CSS clamp(…,920px) 一致。 */
export const PANEL_CONTENT_ADAPTIVE_MAX = 920

/** 宽度协议 CSS 变量名（任何插件可读写，与官方命名一致）。 */
export const PANEL_WIDTH_VARS = {
  /** ResizeObserver 发布的对话列宽（px）。 */
  column: '--dsh-conversation-column-width',
  /** 拖拽偏好（px，拖动中实时写入；无偏好时由 CSS 回退自适应 clamp）。 */
  user: '--dsh-chat-user-width',
  /** 内容列实际宽度（px，`var(--dsh-chat-user-width, clamp(…))` 派生）。 */
  content: '--dsh-chat-content-width',
  /** 手柄 hover 发光条跟随指针的 Y（px，相对手柄自身盒）。 */
  pointerY: '--dsh-width-handle-pointer-y',
} as const
