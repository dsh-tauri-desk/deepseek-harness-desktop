/** Stable client-side identifiers shared by the panel implementation. */
export { PANEL_CONTENT_ADAPTIVE_MAX, PANEL_CONTENT_ADAPTIVE_MIN, PANEL_CONTENT_DEFAULT, PANEL_CONTENT_EDGE_BUDGET, PANEL_CONTENT_MIN, PANEL_WIDTH_PREF_KEY, PANEL_WIDTH_VARS } from './width'

export const PANEL_PROTOCOL_SERVICE = 'panel.protocol'
export const PANEL_VIEW_SLOT = 'conversation'
export const PANEL_VIEW_COMPONENT_ID = 'dsh-tauri-panel-conversation-seat'
export const PANEL_STYLE_ID = 'dsh-tauri-panel-styles'
export const COLLAPSE_SETTLE_MS = 150
export const SCROLLBAR_LINGER_MS = 2000
export const SIDEBAR_INTERACTIVE_SELECTOR = 'button,a[href],input,select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="tab"],[role="treeitem"][aria-selected]'
export const WORKSPACE_GROUP_SELECTOR = '[role="treeitem"][aria-expanded]'

/**
 * 只改变侧栏呈现、不应关闭面板的官方控件。dsh-client-ui-workspace 的工作区头部
 * “分组方式”（viewOptions.label）与“添加工作区”（workspace.add）按钮的
 * aria-label 随 locale 变化（仓库仅内置 zh/en 两组），这里同时匹配两种语言。
 */
export const SIDEBAR_KEEP_OPEN_SELECTOR = 'button[aria-label="视图选项"],button[aria-label="View options"],button[aria-label="添加工作区"],button[aria-label="Add workspace"]'

export const PANEL_CLASSES = {
  root: 'dshp-root',
  collapsed: 'dshp-collapsed',
  railIn: 'dshp-railIn',
  fading: 'dshp-fading',
  quietBars: 'dshp-quietBars',
  wide: 'dshp-wide',
  logoRow: 'dshp-logoRow',
  brand: 'dshp-brand',
  brandIdentity: 'dshp-brandIdentity',
  brandMark: 'dshp-brandMark',
  brandName: 'dshp-brandName',
  fallbackBrandName: 'dshp-fallbackBrandName',
  iconButton: 'dshp-iconButton',
  toggle: 'dshp-toggle',
  railMark: 'dshp-railMark',
  panelArea: 'dshp-panelArea',
  menuItem: 'dshp-menuItem',
  menuItemSelected: 'dshp-menuItemSelected',
  newSession: 'dshp-newSession',
  menuItemIcon: 'dshp-menuItemIcon',
  menuItemLabel: 'dshp-menuItemLabel',
  regionArea: 'dshp-regionArea',
  footArea: 'dshp-footArea',
  footerActions: 'dshp-footerActions',
  settingsArea: 'dshp-settingsArea',
  panelView: 'dshp-panelView',
  panelViewColumn: 'dshp-panelViewColumn',
  widthHandle: 'dshp-widthHandle',
} as const

export const PANEL_DATA_ATTRIBUTES = {
  sidebar: 'data-dshp-panel-sidebar',
  active: 'data-dshp-panel-active',
  action: 'data-dshp-panel-action',
  view: 'data-dshp-panel-view',
  widthHandle: 'data-width-handle',
} as const
