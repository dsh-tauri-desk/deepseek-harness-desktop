/** Stable client protocol identifiers and shared UI defaults for dsh-tauri-pet. */
export const PET_CLIENT_PLUGIN = 'dsh-tauri-pet'
export const PET_SECTION_ID = 'dsh-tauri-pet-settings'
export const PET_SECTION_ORDER = 230
export const PET_STYLES_EFFECT = 'dsh-tauri-pet: styles'
export const PET_SECTION_EFFECT = 'dsh-tauri-pet: settings section'
export const PET_ICON_PATCH_EFFECT = 'dsh-tauri-pet: sidebar icon patch'
export const PET_PREFILL_EFFECT = 'dsh-tauri-pet: conversation prefill'
export const PET_CLIENT_NS = 'dsh-tauri-pet'
export const CONVERSATION_INPUT_LEFT_SLOT = 'conversation.input.left'
export const PET_PREFILL_ID = 'dsh-tauri-pet-prefill'
export const PET_PREFILL_ORDER = 230
export const PET_PREFILL_PRIORITY = 0
export const PET_HATCH_PROMPT = '/hatch-dsh-pet 根据你对我的了解，养一只宠物'
export const CMD_GET_PET_STATUS = 'get_pet_status'
export const CMD_SET_PET_ENABLED = 'set_pet_enabled'
export const CMD_SET_ACTIVE_PET = 'set_active_pet'
export const CMD_SET_PET_SIZE = 'set_pet_size'
export const CMD_LIST_PETS = 'list_pets'
export const CMD_IMPORT_PET = 'import_pet'
export const CMD_GET_PET_ASSET = 'get_pet_asset'
/** 预设清单（`resources/preset-pets.json`）——预设直连远端素材，只有读取没有安装。 */
export const CMD_LIST_PRESET_PETS = 'list_preset_pets'
export const SIDEBAR_SELECTOR = '[data-slot="sidebar"]'
export const SETTINGS_TRIGGER_SELECTOR = '.dshp-settings-trigger'
export const PET_ICON_ATTRIBUTE = 'data-dsh-tauri-pet-icon'
export const PET_SETTINGS_ROW_CLASS = 'dshp-pet__settings-row'
export const PET_ICON_RETRY_MS = 500
export const PET_ICON_RETRY_MAX = 30
export const PET_DEFAULT_SIZE = 100
export const PET_SIZE_MIN = 50
export const PET_SIZE_MAX = 200
export const PET_SIZE_STEP = 5
