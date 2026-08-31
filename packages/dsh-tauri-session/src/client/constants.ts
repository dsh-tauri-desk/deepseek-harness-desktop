/** Shared protocol and UI constants for the dsh-tauri-session client plugin. */

export const SESSION_CLIENT_PLUGIN = 'dsh-tauri-session'
export const SESSION_CLIENT_NS = SESSION_CLIENT_PLUGIN
export const SESSION_API_PREFIX = '/api/dsh-session'
export const SESSION_REGISTRANT = SESSION_CLIENT_PLUGIN

export const SETTINGS_SECTION_SLOT = 'settings.section'
export const SESSION_SECTION_ID = 'dsh-tauri-session-archive'
export const SESSION_SECTION_ORDER = 220

export const SESSION_STYLE_ID = 'dsh-tauri-session-styles'

/** Effects / lifecycle ids (诊断元数据). */
export const SESSION_STYLES_EFFECT = `${SESSION_CLIENT_PLUGIN}: styles`
export const SESSION_ARCHIVE_PATCH_EFFECT = `${SESSION_CLIENT_PLUGIN}: workspace archive patch`
export const SESSION_ARCHIVE_SECTION_EFFECT = `${SESSION_CLIENT_PLUGIN}: archive section`

/** css-render class prefix (value 仅用于样式命名，不作为协议). */
export const SESSION_CLASSES = {
  page: 'dsh-tauri-session-page',
  header: 'dsh-tauri-session-header',
  title: 'dsh-tauri-session-title',
  deleteAll: 'dsh-tauri-session-delete-all',
  toolbar: 'dsh-tauri-session-toolbar',
  search: 'dsh-tauri-session-search',
  menuSelect: 'dsh-tauri-session-menu-select',
  menuSelectLabel: 'dsh-tauri-session-menu-select-label',
  menuSelectChevron: 'dsh-tauri-session-menu-select-chevron',
  groups: 'dsh-tauri-session-groups',
  group: 'dsh-tauri-session-group',
  groupHeader: 'dsh-tauri-session-group-header',
  groupTitle: 'dsh-tauri-session-group-title',
  groupCount: 'dsh-tauri-session-group-count',
  groupMenu: 'dsh-tauri-session-group-menu',
  groupMenuTrigger: 'dsh-tauri-session-group-menu-trigger',
  list: 'dsh-tauri-session-list',
  row: 'dsh-tauri-session-row',
  rowMain: 'dsh-tauri-session-row-main',
  rowTitle: 'dsh-tauri-session-row-title',
  rowTime: 'dsh-tauri-session-row-time',
  rowActions: 'dsh-tauri-session-row-actions',
  rowDelete: 'dsh-tauri-session-row-delete',
  unarchive: 'dsh-tauri-session-unarchive',
  deleteBtn: 'dsh-tauri-session-delete-btn',
  deleteBtnText: 'dsh-tauri-session-delete-btn-text',
  empty: 'dsh-tauri-session-empty',
  error: 'dsh-tauri-session-error',
  toastView: 'dsh-tauri-session-toast-view',
  archiveMenuItem: 'dsh-tauri-session-archive-menu-item',
} as const

/**
 * Sync strings for matching the official workspace-row menu's delete item
 * (zh/en). The item is a primitives `Menu` row rendered in a portal, so the
 * patch scans `document.body`, not the sidebar.
 */
export const DELETE_WORKSPACE_LABELS: readonly string[] = ['删除工作区', 'Delete workspace']

/** Official primitives menu row selector (portal). */
export const MENU_ITEM_SELECTOR = 'button[role="menuitem"]'

/** Sidebar shell seat holding the official WorkspaceBrowser. */
export const SIDEBAR_SELECTOR = '[data-slot="sidebar"]'

/** Attribute marking a project-row ellipsis whose click records the open menu's workspace. */
export const WORKSPACE_MENU_ANCHOR_ATTRIBUTE = 'data-dsh-tauri-session-menu-anchor'
/** Attribute marking a portal workspace menu already patched with the archive item. */
export const WORKSPACE_MENU_PATCH_ATTRIBUTE = 'data-dsh-tauri-session-archive-menu-patched'
