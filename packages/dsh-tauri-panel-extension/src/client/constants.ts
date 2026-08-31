export const PLUGIN_ID = 'dsh-tauri-panel-extension'
export const API_PREFIX = '/dsh-tauri-panel-extension'
export const LOCALE_NAMESPACE = 'dsh-tauri-panel-extension'
export const PANEL_PROTOCOL_NAME = 'panel.protocol'
export const PANEL_SLOT_NAME = 'sidebar.panel.action'
export const CONVERSATION_INPUT_LEFT_SLOT = 'conversation.input.left'
export const PANEL_ID = 'dsh-tauri-panel-extension'
export const PANEL_ACTION_ID = 'dsh-tauri-panel-extension.action'
export const PANEL_ACTION_ORDER = 40
export const PANEL_ACTION_PRIORITY = 0
export const INPUT_PREFILL_ID = 'dsh-tauri-panel-extension.skill-prefill'
export const INPUT_PREFILL_ORDER = 40
export const INPUT_PREFILL_PRIORITY = 0
export const STYLE_ID = 'dsh-tauri-panel-extension-styles'
export const SKILL_CREATOR_DRAFT = '/skill-creator '
export const SKILL_REFRESH_INTERVAL_MS = 300
export const SKILL_REFRESH_TIMEOUT_MS = 5_000
export const IMPORT_REFRESH_DELAYS_MS = [250, 750, 1_500] as const
export const MCP_RESTART_INITIAL_DELAY_MS = 3_000
export const MCP_RESTART_POLL_INTERVAL_MS = 1_500
export const MCP_RESTART_TIMEOUT_MS = 60_000
export const GITHUB_REPOSITORY_PATTERN = /^(?:https?:\/\/github\.com\/)?[\w.-]+\/[\w.-]+\/?$/i

export const SOURCE_LOCALE_KEYS: Readonly<Record<string, string>> = {
  'project-dsh': 'sourceProjectDsh',
  'project-agents': 'sourceProjectAgents',
  'user-dsh': 'sourceUserDsh',
  'user-agents': 'sourceUserAgents',
  'runtime': 'sourceRuntime',
  'bundled': 'sourceBundled',
  'custom': 'sourceCustom',
}
