export const PLUGIN_ID = 'dsh-tauri-panel-placeholder'
export const LOCALE_NAMESPACE = 'placeholder'
export const PANEL_LOCALE_KEY = 'panel.placeholder'
export const PANEL_ID = 'placeholder'
/**
 * 宿主私有面板槽：本插件只用它作为「宿主已 apply」的就绪门槛
 * （实际注册经 panel.protocol.registerPanel，槽名由宿主按核心版本决定）。
 */
export const PANEL_SLOT_NAME = 'sidebar.panel.action'
export const PANEL_PROTOCOL_NAME = 'panel.protocol'
export const PANEL_ORDER = 10
export const STYLE_ID = 'dsh-tauri-panel-placeholder-styles'
export const PLACEHOLDER_CENTER_CLASS = 'dshp-placeholder__center'
export const PLACEHOLDER_TEXT_CLASS = 'dshp-placeholder__text'
