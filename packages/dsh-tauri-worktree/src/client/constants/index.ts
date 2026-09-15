import { WORKTREE_PLUGIN_NAME } from '../../shared/constants'

export { WORKTREE_API_PREFIX, WORKTREE_PLUGIN_NAME } from '../../shared/constants'

export const INPUT_DOCK_SLOT = 'conversation.input.dock'
export const SHELL_OVERLAY_SLOT = 'shell.overlay'
export const MODE_SELECT_ID = `${WORKTREE_PLUGIN_NAME}-mode`
export const MODE_SELECT_ORDER = -20
export const SURFACE_ID = `${WORKTREE_PLUGIN_NAME}-surface`
export const SURFACE_ORDER = -10
export const DIALOG_ID = `${WORKTREE_PLUGIN_NAME}-dialog`

export const STYLES_EFFECT = `${WORKTREE_PLUGIN_NAME}: styles`
export const LOCALE_EFFECT = `${WORKTREE_PLUGIN_NAME}: locale`
export const PREFERENCES_EFFECT = `${WORKTREE_PLUGIN_NAME}: preferred mode`
export const MODE_SELECT_EFFECT = `${WORKTREE_PLUGIN_NAME}: mode select slot`
export const SURFACE_EFFECT = `${WORKTREE_PLUGIN_NAME}: surface slot`
export const DIALOG_EFFECT = `${WORKTREE_PLUGIN_NAME}: dialog`
export const HYDRATION_EFFECT = `${WORKTREE_PLUGIN_NAME}: hydrate session bindings`
export const SESSION_ICONS_EFFECT = `${WORKTREE_PLUGIN_NAME}: session branch icons`

export const SESSION_SWITCH_RETRY_DELAY_MS = 100
export const SESSION_SWITCH_MAX_ATTEMPTS = 30

export const HYDRATION_RETRY_DELAY_MS = 1500
export const HYDRATION_MAX_RETRIES = 30
export const HYDRATION_RETRY_WINDOW_MS = 10_000
export const HYDRATION_RETRY_BUDGET_PER_SECOND = 8
export const SESSION_RECONCILE_MIN_INTERVAL_MS = 1200
export const DISCARD_POLL_DELAY_MS = 500
export const DISCARD_MAX_POLLS = 120

export const HANDOFF_WINDOW_MS = 60_000

export const MODE_SELECT_STYLE_ID = '@deepseek-ai/dsh-tauri-worktree/ModeSelect.module.css'
export const WORKTREE_STYLE_ID = '@deepseek-ai/dsh-tauri-worktree/SurfaceDialog.module.css'
export const SURFACE_STYLE_ID = '@deepseek-ai/dsh-tauri-worktree/Surface.module.css'
export const DIALOG_STYLE_ID = '@deepseek-ai/dsh-tauri-worktree/Dialog.module.css'
export const SESSION_ICON_STYLE_ID = '@deepseek-ai/dsh-tauri-worktree/SessionBranchIcon.module.css'

export const PREFERRED_MODE_STORAGE_KEY = 'preferred-mode'

export const SESSION_ICON_ATTRIBUTE = 'data-dsh-worktree-icon'
export const SIDEBAR_SELECTOR = '[data-slot="sidebar"]'
export const COMPOSER_SEAT_SELECTOR = '[data-composer-seat]'
export const COMPOSER_CARD_SELECTOR = '[data-composer-card="true"]'
export const HERO_PRESET_SLOT_SELECTOR = '[data-slot="conversation.hero.agentPreset"]'
export const COMPOSER_PLAN_SLOT_SELECTOR = '[data-slot="conversation.input.plan"]'
export const COMPOSER_MODE_BUTTON_SELECTOR = `${COMPOSER_CARD_SELECTOR} button[aria-label*="访问模式"], ${COMPOSER_CARD_SELECTOR} button[aria-label*="Access mode"]`
export const MODE_ANCHOR_ATTRIBUTE = 'data-dsh-tauri-worktree-mode-anchor'
