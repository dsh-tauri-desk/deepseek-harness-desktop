export const WORKTREE_BRANCH_NAME_PATTERN = /^[\w./-]+$/

export const WORKTREES_DIR = 'worktrees'
export const TRASH_DIR = '.trash'
export const LEDGER_DIR = 'ledger'
export const CHECKOUT_CONTEXT_DIR = 'checkout-context'

export const DISCARD_JOB_RETENTION = 64
export const DISCARD_RETRY_ATTEMPTS = 3
export const DISCARD_RETRY_DELAY_MS = 2_000

export const DEFAULT_LINK_DIRECTORIES: readonly string[] = ['node_modules']

export const LINK_DEPENDENCIES = true

export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'shell',
  'sh',
  'zsh',
  'terminal',
  'run_command',
  'exec',
])

export const INSTALL_PATTERNS: readonly RegExp[] = [
  /\b(?:npm|pnpm|yarn|yarnpkg|bun|corepack|pnpx|npx)\s+(?:install|i|ci|add|update|upgrade|up|remove|rm|uninstall|unlink|link|dedupe|prune|rebuild|install-test|it)\b/i,
  /(?:^|[\s;&|()])yarn\s*(?:$|[\s;&|()])/i,
  /\b(?:pip|pip3|pipenv|poetry|uv|conda|mamba)\s+(?:install|sync|add|update|upgrade|lock|remove|uninstall)\b/i,
  /\bcargo\s+(?:fetch|build|install|update)\b/i,
  /\bgo\s+(?:mod\s+(?:download|tidy|vendor)|get)\b/i,
  /\b(?:bundle|bundler)\s+install\b/i,
  /\bcomposer\s+(?:install|update|require|remove)\b/i,
  /\bdotnet\s+(?:restore|add\s+package)\b/i,
  /\b(?:mvn|maven|gradle|gradlew)\b[^\n;&|]+\bdependenc(?:y|ies)\b/i,
]
