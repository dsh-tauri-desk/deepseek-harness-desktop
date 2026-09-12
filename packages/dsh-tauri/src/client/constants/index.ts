// ── dsh-tauri invoke 桥（iframe → 宿主 → invoke() → 回传）─────────────
// iframe 内的 dsh 界面 / 插件无法直接访问 `@tauri-apps/api`（`__TAURI_INTERNALS__`
// 只在顶层 webview）。本桥让客户端经 postMessage 把 command 上报到宿主（主
// webview）监听器，由宿主调用 Tauri `invoke` 并把结果回传给 iframe。
/** iframe → 宿主：invoke 请求的 source。 */
export const SRC_INVOKE = 'dsh-tauri-invoke'
/** 宿主 → iframe：invoke 应答的 source。 */
export const SRC_INVOKE_REPLY = 'dsh-desktop-invoke'
/** invoke 请求消息类型。 */
export const TYPE_INVOKE = 'dsh://tauri:invoke'
/** invoke 应答消息类型。 */
export const TYPE_INVOKE_REPLY = 'dsh://tauri:reply'
/** 单次 invoke 等待宿主应答的最长毫秒数（超时按失败处理）。 */
export const INVOKE_TIMEOUT_MS = 15000

/**
 * 宿主 → iframe：Tauri 事件转发的消息类型（`listen()` 消费）。
 *
 * 与桌面端 `useListenIframe` 的 `forward()` 返回的 `type` 必须逐字一致；
 * 配对关系：宿主 `useListenIframe(iframeRef, event, payload => ({ type: TYPE_EVENT, event, payload }))`
 * ↔ 客户端 `listen(event, handler)`。
 */
export const TYPE_EVENT = 'dsh://tauri:event'

/** 宿主 → iframe：侧边栏切换命令（`register/sidebar.ts` 消费）。 */
export const CMD_TOGGLE = 'dsh://sidebar:toggle'

/** iframe → 宿主：侧边栏折叠状态回报（`register/sidebar.ts` 发送）。 */
export const EVENT_SIDEBAR_COLLAPSED = 'dsh://sidebar:collapsed'

/** iframe → 宿主：缩放快捷键动作（`register/zoom-shortcut.ts` 发送；宿主据此更新缩放真值）。 */
export const TYPE_ZOOM_SHORTCUT = 'dsh://zoom-shortcut'

/** dsh 应用布局根（AppFrame）：`data-shell-overlay` 的父节点，带侧边栏折叠属性。 */
export const SIDEBAR_FRAME_SELECTOR = '[data-shell-overlay]'
export const SIDEBAR_COLLAPSED_ATTRIBUTE = 'data-sidebar-collapsed'

/** 应用晚挂载时补报一次侧边栏折叠状态的轮询参数（拿到 AppFrame 即停）。 */
export const SIDEBAR_TRACK_MAX_TRIES = 30
export const SIDEBAR_TRACK_INTERVAL_MS = 500

/** 上报消息的 type key（宿主按 `type` 分发：`dsh://plugin-error`）。 */
export const ERROR_TYPE = 'dsh://plugin-error'

/** 插件 id（npm 包名）：宿主错误注册表与插件列表的主键。 */
export const PLUGIN_ID = 'dsh-tauri'

/** 客户端插件元数据与生命周期标识。 */
export const PLUGIN_INJECT = ['layout']
export const SIDEBAR_TWEAKS_STYLE_ID = 'dsh-tauri:sidebar-tweaks'
export const SIDEBAR_TWEAKS_EFFECT_ID = 'dsh-tauri: sidebar tweaks (hide collapse toggle, center brand)'
export const SIDEBAR_TOGGLE_EFFECT_ID = 'dsh-tauri: sidebar (toggle command + collapsed report)'
export const ZOOM_SHORTCUT_EFFECT_ID = 'dsh-tauri: zoom shortcuts (ctrl/cmd +/-/0)'

/** 侧边栏稳定 ARIA 选择器。 */
export const COLLAPSE_SIDEBAR_SELECTOR = 'button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"]'
export const NEW_SESSION_SELECTOR = 'button[aria-label="新建会话"],button[aria-label="New session"]'
