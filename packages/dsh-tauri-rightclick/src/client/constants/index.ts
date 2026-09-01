/** Shared protocol and UI constants for the dsh-tauri-rightclick client plugin. */

export const RIGHTCLICK_CLIENT_PLUGIN = 'dsh-tauri-rightclick'
export const RIGHTCLICK_CLIENT_NS = RIGHTCLICK_CLIENT_PLUGIN
export const RIGHTCLICK_API_PREFIX = '/api/dsh-rightclick-menu'

/** 用系统默认浏览器打开外链（POST，同源 JSON）。 */
export const OPEN_URL_ROUTE = `${RIGHTCLICK_API_PREFIX}/open-url`
/** 宿主 openPath RPC（资源管理器打开目录；绕过 better-sidebar 对 workspaces.openPath 的包装）。 */
export const HOST_OPEN_PATH_ENDPOINT = '/api/host.openPath'

/** css-render style id。 */
export const RIGHTCLICK_STYLE_ID = 'dsh-tauri-rightclick-styles'

/** Effects / lifecycle ids（诊断元数据）。 */
export const RIGHTCLICK_STYLES_EFFECT = `${RIGHTCLICK_CLIENT_PLUGIN}: styles`
export const RIGHTCLICK_MENU_EFFECT = `${RIGHTCLICK_CLIENT_PLUGIN}: context menu`

/** css-render class prefix（跨插件协议暴露给扩展事件 detail 的 DOM 结构保持稳定）。 */
export const RIGHTCLICK_CLASSES = {
  menu: 'dsh-tauri-rightclick',
  item: 'dsh-tauri-rightclick-item',
  itemDanger: 'dsh-tauri-rightclick-item--danger',
  shortcut: 'dsh-tauri-rightclick-shortcut',
  separator: 'dsh-tauri-rightclick-separator',
  toast: 'dsh-tauri-rightclick-toast',
} as const

/** 扩展注册表协议（其他 Web 插件经 globalThis[Symbol.for(KEY)] 登记扩展项）。 */
export const EXTENSIONS_REGISTRY_KEY = 'dsh.rightclick-menu.extensions'
/** 注册表租约协议（插件实例持有/释放全局注册表）。 */
export const EXTENSIONS_LEASE_KEY = 'dsh.rightclick-menu.lease'

/** 每次打开右键菜单时派发的事件（detail 含 row/action/session/workspace/target/x/y/extensions）。 */
export const CONTEXT_MENU_EVENT = 'dsh:rightclick-menu'

/** Toast 展示时长（毫秒）。 */
export const TOAST_DURATION_MS = 1800

/** 菜单最小/最大宽度与视口边距。 */
export const MENU_MIN_WIDTH = 148
export const MENU_MAX_WIDTH = 260
export const MENU_VIEWPORT_MARGIN = 6
