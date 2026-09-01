/** Shared protocol and UI constants for the dsh-tauri-ui client plugin. */

export const SETTINGS_UI_PLUGIN = 'dsh-tauri-ui'
export const SETTINGS_UI_NS = SETTINGS_UI_PLUGIN

export const SETTINGS_SHELL_OVERLAY_SLOT = 'shell.overlay'
export const SETTINGS_SIDEBAR_SLOT = 'sidebar.settings'
export const SETTINGS_SECTION_SLOT = 'settings.section'
export const SETTINGS_TRIGGER_SLOT = 'settings.trigger'
export const SETTINGS_ONBOARDING_SLOT = 'settings.onboarding'

export const SETTINGS_SHELL_SEAT_ID = SETTINGS_UI_PLUGIN
export const SETTINGS_SIDEBAR_ID = 'dsh-tauri-ui-settings'
export const SETTINGS_STYLE_ID = 'dsh-tauri-ui-settings-styles'
export const SETTINGS_REGISTRANT = SETTINGS_UI_PLUGIN
export const SETTINGS_TRIGGER_PRIORITY = -1

export const SETTINGS_UNDERLAY_SLOT_KEYS = ['sidebar', 'conversation', 'details'] as const
export const SETTINGS_EXTERNAL_OVERLAY_SELECTORS = ['[data-dsh-better-sidebar]', '[data-dsh-panel]'] as const

export const RAIL_WIDTH_MIN = 264
export const RAIL_WIDTH_MAX = 420
export const RAIL_WIDTH_DEFAULT = 280

export const DICT_ZH = {
  back: '返回应用',
  search: '搜索设置…',
  settings: '设置',
  noResults: '没有匹配的设置项',
} as const

export const DICT_EN: Record<keyof typeof DICT_ZH, string> = {
  back: 'Back to app',
  search: 'Search settings…',
  settings: 'Settings',
  noResults: 'No matching settings',
}
