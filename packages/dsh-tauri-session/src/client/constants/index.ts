import { SESSION_PLUGIN_NAME } from '../../shared/constants'

export { SESSION_API_PREFIX, SESSION_PLUGIN_NAME, SESSION_SECTION_ORDER } from '../../shared/constants'

export const SETTINGS_SECTION_SLOT = 'settings.section'
export const SESSION_REGISTRANT = SESSION_PLUGIN_NAME
export const SESSION_SECTION_ID = `${SESSION_PLUGIN_NAME}-archive`

export const SESSION_STYLE_ID = `${SESSION_PLUGIN_NAME}-styles`
export const SESSION_MENU_STYLE_ID = `${SESSION_PLUGIN_NAME}-menu-styles`

export const LOCALE_EFFECT = `${SESSION_PLUGIN_NAME}: locale`
export const STYLES_EFFECT = `${SESSION_PLUGIN_NAME}: styles`
export const ARCHIVE_SECTION_EFFECT = `${SESSION_PLUGIN_NAME}: archive section`
export const WORKSPACE_PATCH_EFFECT = `${SESSION_PLUGIN_NAME}: workspace archive patch`

export const ARCHIVE_RESYNC_TIMEOUT_MS = 2_000
export const SIDEBAR_ATTACH_POLL_MS = 500
export const SIDEBAR_ATTACH_MAX_TRIES = 30

/** 主题工作区行的「删除工作区」条目文案（zh/en），用作 portal 菜单识别锚点。 */
export const DELETE_WORKSPACE_LABELS: readonly string[] = ['删除工作区', 'Delete workspace']

export const SIDEBAR_SELECTOR = '[data-slot="sidebar"]'
export const TIMELINE_ROW_SELECTOR = '[role="treeitem"][aria-expanded]'
export const MENU_ITEM_SELECTOR = 'button[role="menuitem"]'
export const MENU_ITEM_WRAP_SELECTOR = '[class*="itemWrap"]'
export const MENU_ITEM_LABEL_SELECTOR = '[class*="itemLabel"]'
export const MENU_ITEM_ICON_SELECTOR = '[class*="itemIcon"]'

export const ARCHIVE_MENU_ITEM_ATTRIBUTE = 'data-dsh-tauri-session-archive-item'
export const ARCHIVE_MENU_PATCH_ATTRIBUTE = 'data-dsh-tauri-session-archive-menu-patched'
export const ARCHIVE_MENU_ITEM_CLASS = 'dshp-session__archive-menu-item'
