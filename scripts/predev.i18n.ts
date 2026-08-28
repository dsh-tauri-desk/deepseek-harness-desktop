import process from 'node:process'

export type PredevLocale = 'en-US' | 'zh-CN'

const messages = {
  'en-US': {
    'command.description': 'Prepare the internal plugin environment and forward Tauri CLI commands',
    'command.yes': 'Skip confirmation before cloning internal plugins',
    'command.lang': 'Set the command language',
    'env.configured': 'Updated .env: DEV_INTERNAL_PLUGINS_DIR={dir}',
    'git.checking': 'Checking submodule updates: {dir}',
    'git.latest': 'dsh-tauri-plugins is up to date',
    'git.updated': 'dsh-tauri-plugins has been updated',
    'plugin.confirm': 'DEV_INTERNAL_PLUGINS_DIR is not set. Clone dsh-tauri-plugins as a submodule?',
    'plugin.invalid_dir': 'The directory exists but is not a Git submodule: {dir}',
    'plugin.exists': 'Submodule directory already exists: {dir}',
  },
  'zh-CN': {
    'command.description': '准备内置插件环境并转发 Tauri CLI 命令',
    'command.yes': '跳过内置插件拉取确认',
    'command.lang': '设置命令语言',
    'env.configured': '已设置 .env：DEV_INTERNAL_PLUGINS_DIR={dir}',
    'git.checking': '检查子模块更新：{dir}',
    'git.latest': 'dsh-tauri-plugins 已是最新版本',
    'git.updated': 'dsh-tauri-plugins 已更新',
    'plugin.confirm': '你的内置环境目录 DEV_INTERNAL_PLUGINS_DIR 环境未设置，是否拉取 dsh-tauri-plugins 作为子模块？',
    'plugin.invalid_dir': '目录已存在但不是 Git 子模块：{dir}',
    'plugin.exists': '子模块目录已存在：{dir}',
  },
} as const

export type PredevMessageKey = keyof typeof messages['en-US']

export function detectLocale(explicitLocale?: string): PredevLocale {
  if (explicitLocale === 'en-US' || explicitLocale === 'zh-CN')
    return explicitLocale

  const environmentLocale = process.env.LC_ALL
    || process.env.LC_MESSAGES
    || process.env.LANG
    || new Intl.DateTimeFormat().resolvedOptions().locale

  return environmentLocale.toLowerCase().replace('_', '-').startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function translate(
  locale: PredevLocale,
  key: PredevMessageKey,
  replacements: Record<string, string> = {},
): string {
  return Object.entries(replacements).reduce(
    (message, [name, value]) => message.split(`{${name}}`).join(value),
    messages[locale][key] as string,
  )
}
