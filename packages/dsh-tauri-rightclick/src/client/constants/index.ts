import { RIGHTCLICK_PLUGIN_NAME } from '../../shared/constants'

export {
  OPEN_PATH_ROUTE,
  OPEN_URL_ROUTE,
  RIGHTCLICK_API_PREFIX,
  RIGHTCLICK_PLUGIN_NAME,
} from '../../shared/constants'

export const LOCALE_EFFECT = `${RIGHTCLICK_PLUGIN_NAME}: locale`
export const STYLES_EFFECT = `${RIGHTCLICK_PLUGIN_NAME}: styles`
export const CONTEXT_MENU_EFFECT = `${RIGHTCLICK_PLUGIN_NAME}: context menu`

export const MENU_STYLE_ID = `${RIGHTCLICK_PLUGIN_NAME}-menu-styles`

export const MENU_BLOCK = 'dshp-menu'
export const MENU_ITEM_CLASS = `${MENU_BLOCK}__item`
export const MENU_ITEM_DANGER_CLASS = `${MENU_ITEM_CLASS}--danger`
export const MENU_SHORTCUT_CLASS = `${MENU_BLOCK}__shortcut`
export const MENU_SEPARATOR_CLASS = `${MENU_BLOCK}__separator`
export const TOAST_CLASS = 'dshp-toast'

export const TREE_ITEM_SELECTOR = '[role="treeitem"]'
export const TREE_ITEM_EXPANDED_SELECTOR = '[role="treeitem"][aria-expanded]'
export const ACTION_BUTTON_SELECTOR = 'button[aria-label]'
export const LINK_SELECTOR = 'a[href]'
export const MENU_ITEM_SELECTOR = '[role="menuitem"]'
export const EDITABLE_SELECTOR = 'input:not([type="button"]):not([type="submit"]),textarea,[contenteditable="true"]'
export const CONVERSATION_SELECTOR = '[data-slot="conversation.session"]'
export const DIALOG_SELECTOR = '[role="dialog"]'
export const HERO_SELECTOR = '[data-phase="hero"]'
export const CONVERSATION_SCROLL_SELECTOR = ':scope > [data-conversation-scroll]'

export const EXTENSIONS_REGISTRY_KEY = 'dsh.rightclick-menu.extensions'
export const CONTEXT_MENU_EVENT = 'dsh:rightclick-menu'

export const TOAST_DURATION_MS = 1800
export const MENU_VIEWPORT_MARGIN = 6
