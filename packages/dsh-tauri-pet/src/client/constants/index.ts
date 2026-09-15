import { PET_PLUGIN_NAME } from '../../shared/constants'

/** settings.section 槽位里的桌宠分区标识与排序权重。 */
export const PET_SECTION_ID = 'dsh-tauri-pet-settings'
export const PET_SECTION_ORDER = 230

/** 样式挂载 id 与 effect 标签。 */
export const PET_STYLES_ID = 'dsh-tauri-pet-styles'
export const PET_SETTINGS_STYLES_ID = 'dsh-tauri-pet-settings-styles'
export const PET_CARD_STYLES_ID = 'dsh-tauri-pet-card-styles'
export const PET_LOCALE_EFFECT = `${PET_PLUGIN_NAME}: locale`
export const PET_STYLES_EFFECT = `${PET_PLUGIN_NAME}: styles`
export const PET_SECTION_EFFECT = `${PET_PLUGIN_NAME}: settings section`
export const PET_ICON_PATCH_EFFECT = `${PET_PLUGIN_NAME}: sidebar icon patch`
export const PET_PREFILL_EFFECT = `${PET_PLUGIN_NAME}: conversation prefill`

/** conversation.input.left 槽位里的一次性草稿注入。 */
export const CONVERSATION_INPUT_LEFT_SLOT = 'conversation.input.left'
export const PET_PREFILL_ID = 'dsh-tauri-pet-prefill'
export const PET_PREFILL_ORDER = 230
export const PET_PREFILL_PRIORITY = 0
export const PET_HATCH_PROMPT = '/hatch-dsh-pet 根据你对我的了解，养一只宠物'

/** 桌面端 Tauri 命令 id（与 src-tauri 的 command 名逐字一致）。 */
export const CMD_GET_PET_STATUS = 'get_pet_status'
export const CMD_SET_PET_ENABLED = 'set_pet_enabled'
export const CMD_SET_ACTIVE_PET = 'set_active_pet'
export const CMD_SET_PET_SIZE = 'set_pet_size'
export const CMD_LIST_PETS = 'list_pets'
export const CMD_IMPORT_PET = 'import_pet'
export const CMD_LIST_PRESET_PETS = 'list_preset_pets'

/** 侧栏入口补丁的稳定选择器与守卫属性（禁止依赖文案或动态类名）。 */
export const SIDEBAR_SELECTOR = '[data-slot="sidebar"]'
export const SETTINGS_TRIGGER_SELECTOR = '.dshp-settings-trigger'
/** 折叠态（Rail 圆形按钮）标记：官方 trigger 组件在窄侧栏下附加，保持定宽不拉伸。 */
export const SETTINGS_TRIGGER_RAIL_CLASS = 'dshp-settings-trigger--rail'
export const PET_ICON_ATTRIBUTE = 'data-dsh-tauri-pet-icon'
export const PET_SETTINGS_ROW_CLASS = 'dshp-pet__settings-row'
export const PET_ICON_RETRY_MS = 500
export const PET_ICON_RETRY_MAX = 30

/** 桌宠窗口大小（百分比）。 */
export const PET_DEFAULT_SIZE = 100
export const PET_SIZE_MIN = 50
export const PET_SIZE_MAX = 200
export const PET_SIZE_STEP = 5
