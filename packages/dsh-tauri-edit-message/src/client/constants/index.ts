/**
 * client/constants/index.ts — 客户端共享常量（barrel）。
 *
 * 类名走 css-render 的 BEM 插件（blockPrefix `.dshp-`），因此这里的字符串常量
 * 与 `styles/editor.cssr.ts` 里 `e()/m()` 生成的类名必须逐字对应。
 */

export { EDIT_MESSAGE_PLUGIN_NAME, MESSAGE_TREE_PATH } from '../../shared/constants'

/** 内置插件 dsh-tauri-session 拥有的会话归档 / 删除路由前缀。 */
export const SESSION_API_PREFIX = '/api/dsh-session'

/** 注入标记属性：渲染 / 遍历都据此跳过插件自己的节点。 */
export const INJECTED_ATTR = 'data-mtx-injected'

/** css-render 挂载用的 style id。 */
export const EDITOR_STYLE_ID = 'dsh-tauri-edit-message/editor'

/* ---- BEM 类名（dshp- 前缀，与 cssr.bem 生成结果一致） ------------------- */

/** 块：`.dshp-edit-message`。 */
export const BLOCK = 'dshp-edit-message'
/** 元素：编辑面板。 */
export const CLS_EDITOR = `${BLOCK}__editor`
/** 元素：多行输入框。 */
export const CLS_TEXTAREA = `${BLOCK}__textarea`
/** 元素：操作区。 */
export const CLS_ACTIONS = `${BLOCK}__actions`
/** 元素：小按钮。 */
export const CLS_BUTTON = `${BLOCK}__btn`
/** 修饰符：主操作（发送）。 */
export const CLS_BUTTON_PRIMARY = `${BLOCK}__btn--primary`
/** 元素：错误行。 */
export const CLS_ERROR = `${BLOCK}__error`
/** 元素：追加进官方操作行的 Edit 图标按钮。 */
export const CLS_EDIT_BTN = `${BLOCK}__edit-btn`
/** 元素：官方没有操作行时自建的一条。 */
export const CLS_OWN_ACTIONS = `${BLOCK}__own-actions`

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
