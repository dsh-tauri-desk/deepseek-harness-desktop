/** 宿主 → iframe 命令的 source。 */
export const SRC_HOST = 'dsh-desktop'

/** iframe → 宿主事件的 source。 */
export const SRC_BRIDGE = 'dsh-nav-bridge'

/** 宿主命令类型。 */
export const CMD_TOGGLE = 'dsh://sidebar:toggle'
export const CMD_PREV = 'dsh://page:prev'
export const CMD_NEXT = 'dsh://page:next'

/** iframe → 宿主状态事件类型。 */
export const EVENT_SIDEBAR_COLLAPSED = 'dsh://sidebar:collapsed'
export const EVENT_PAGE_FIRSTED = 'dsh://page:firsted'
export const EVENT_PAGE_LASTED = 'dsh://page:lasted'

/** 应用晚挂载时的导航桥探测参数。 */
export const TRACK_MAX_TRIES = 30
export const TRACK_INTERVAL_MS = 500

/** 会话行菜单按钮的 aria-label 模板（zh/en），用于提取标题与按标题找行。 */
export const SESSION_LABEL_PATTERNS = [
  /^会话“(.+)”的操作$/,
  /^Session actions for (.+)$/,
] as const

/** 上报消息的 source key（宿主校验：`source === 'dsh-plugin-error-bridge'`）。 */
export const ERROR_SRC = 'dsh-plugin-error-bridge'

/** 上报消息的 type key（宿主校验：`type === 'dsh://plugin-error'`）。 */
export const ERROR_TYPE = 'dsh://plugin-error'

/** 插件 id（npm 包名）：宿主错误注册表与插件列表的主键。 */
export const PLUGIN_ID = 'dsh-tauri'

/** 客户端插件元数据与生命周期标识。 */
export const PLUGIN_INJECT = ['layout']
export const SIDEBAR_TWEAKS_STYLE_ID = 'dsh-tauri:sidebar-tweaks'
export const SIDEBAR_TWEAKS_EFFECT_ID = 'dsh-tauri: sidebar tweaks (hide collapse toggle, center brand)'
export const NAV_BRIDGE_EFFECT_ID = 'dsh-tauri: nav bridge'

/** 侧边栏稳定 ARIA 选择器。 */
export const COLLAPSE_SIDEBAR_SELECTOR = 'button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"]'
export const NEW_SESSION_SELECTOR = 'button[aria-label="新建会话"],button[aria-label="New session"]'
