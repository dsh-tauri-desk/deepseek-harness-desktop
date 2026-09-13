/**
 * client/constants/index.ts — 客户端共享常量。
 *
 * 只放「协议与锚点」：跨半区协议名、注入标记属性、官方内核的稳定语义锚点。
 * **CSS 类名不在这里** —— 样式由 `styles/editor.cssr.ts` 的 bem 助手（`b/e/m`）生成，
 * 组件侧直接引用同一批 .dshp-edit-message__* 类名（与仓库其余组件同一约定）。
 */

export { EDIT_MESSAGE_PLUGIN_NAME, MESSAGE_TREE_PATH } from '../../shared/constants'

/** 内置插件 dsh-tauri-session 拥有的会话归档 / 删除路由前缀。 */
export const SESSION_API_PREFIX = '/api/dsh-session'

/** 注入标记属性：渲染 / 遍历都据此跳过插件自己的节点。 */
export const INJECTED_ATTR = 'data-mtx-injected'

/** 挂在官方气泡上的双击监听标记（避免 React 重建后重复绑定）。 */
export const DOUBLECLICK_ATTR = 'data-mtx-dblclick'

/** css-render 挂载用的 style id。 */
export const EDITOR_STYLE_ID = 'dsh-tauri-edit-message/editor'

/* ---- 官方语义锚点（内核 0.1.2 / 0.1.5 逐字一致） ----------------------- */

export const USER_ROW_SELECTOR = '[data-chat-flow-kind="user"]'
export const USER_TURN_ATTR = 'data-chat-turn'
export const HOST_ACTIONS_CLASS = 'xzv4MW_actions'
export const HOST_ACTION_CLASS = 'xzv4MW_action'
export const HOST_BUBBLE_CLASS = 'Sixlwa_bubble'
export const HOST_STACK_CLASS = 'Sixlwa_userStack'
export const SCROLL_SELECTOR = '[data-conversation-scroll]'

/** 注入节点上的标记值。 */
export const MARK_EDIT = 'edit'
export const MARK_EDITOR = 'editor'
export const MARK_OWN_ACTIONS = 'own-actions'
