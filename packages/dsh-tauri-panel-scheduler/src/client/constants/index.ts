import { SCHEDULER_PLUGIN_NAME } from '../../shared/constants'

export { SCHEDULER_API_PREFIX as API_PREFIX, SCHEDULER_PLUGIN_NAME as PLUGIN_ID } from '../../shared/constants'

export const PANEL_ID = SCHEDULER_PLUGIN_NAME
export const PANEL_ACTION_ORDER = 30

export const CONVERSATION_INPUT_LEFT_SLOT = 'conversation.input.left'
export const INPUT_PREFILL_ID = `${SCHEDULER_PLUGIN_NAME}.prefill`
export const INPUT_PREFILL_ORDER = 40
export const INPUT_PREFILL_PRIORITY = 0

export const STYLE_ID = `${SCHEDULER_PLUGIN_NAME}-styles`
export const SCHEDULER_PANEL_STYLE_ID = `${SCHEDULER_PLUGIN_NAME}-panel-styles`
export const TASK_CARD_STYLE_ID = `${SCHEDULER_PLUGIN_NAME}-task-card-styles`
export const RUNS_TAB_STYLE_ID = `${SCHEDULER_PLUGIN_NAME}-runs-tab-styles`
export const RECOMMENDATIONS_STYLE_ID = `${SCHEDULER_PLUGIN_NAME}-recommendations-styles`
export const MODEL_PICKER_STYLE_ID = `${SCHEDULER_PLUGIN_NAME}-model-picker-styles`
export const MENU_STYLE_ID = `${SCHEDULER_PLUGIN_NAME}-menu-styles`
export const TASK_CREATE_DIALOG_STYLE_ID = `${SCHEDULER_PLUGIN_NAME}-task-create-dialog-styles`
export const SESSION_ICON_STYLE_ID = `${SCHEDULER_PLUGIN_NAME}-session-clock-icon`

export const SESSION_ICON_ATTRIBUTE = 'data-dsh-scheduler-icon'
export const SIDEBAR_SELECTOR = '[data-slot="sidebar"]'

export const REFRESH_INTERVAL_MS = 5_000

export const LOCALE_EFFECT = `${SCHEDULER_PLUGIN_NAME}: locale`
export const STYLES_EFFECT = `${SCHEDULER_PLUGIN_NAME}: styles`
export const HYDRATE_EFFECT = `${SCHEDULER_PLUGIN_NAME}: hydrate`
export const PANEL_EFFECT = `${SCHEDULER_PLUGIN_NAME}: panel`
export const PREFILL_EFFECT = `${SCHEDULER_PLUGIN_NAME}: prefill`
export const SESSION_ICONS_EFFECT = `${SCHEDULER_PLUGIN_NAME}: session clock icons`
