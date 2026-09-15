export const PLUGIN_STATE_DIRECTORY = 'dsh-tauri-panel-extension'

export const DEFAULT_PROFILE = 'web'

export const PROFILES_DIRECTORY = 'profiles'
export const SKILL_DATA_DIRECTORY = 'skills'
export const REPOS_DIRECTORY = 'repos'
export const SKILL_FILE_NAME = 'SKILL.md'
export const STATE_FILE_NAME = 'state.json'

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SKILL_FILE_PATTERN = /[/\\]SKILL\.md$/
export const SKILL_DOCUMENT_PATTERN = /[/\\][^/\\]+\.md$/
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024
export const SKILL_WHEN_TO_USE_MAX_LENGTH = 2048
export const SKILL_CONTENT_MAX_BYTES = 256 * 1024

export const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'
export const SERVER_NAME_RE = /^[\w-]{1,32}$/
export const PATCH_FILE_NAME = 'cordis.patch.yml'
export const EMPTY_PATCH = '[]'
export const MCP_CHECK_TIMEOUT_MS = 5_000

export const GITHUB_URL_RE = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|archive)\/([^/#?]+?)(?:\.tar\.gz)?)?(?:#([^/?#]+))?(?:[/?#].*)?$/
export const GITHUB_SHORT_RE = /^([\w.-]+)\/([\w.-]+)$/
export const GITHUB_FETCH_TIMEOUT_MS = 60_000
export const TARBALL_MAX_BYTES = 256 * 1024 * 1024

export const TAR_LIMITS = {
  entryBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  entries: 20_000,
} as const

export const RMTREE_RETRIES = { maxRetries: 10, retryDelay: 200 } as const

export const RESTART_KILL_DELAY_MS = 500

export const CLAUDE_MCP_FILES = ['.claude/settings.json', '.claude.json'] as const
export const CURSOR_MCP_FILE = '.cursor/mcp.json'
export const GEMINI_MCP_FILE = '.gemini/settings.json'
export const CODEX_MCP_FILE = '.codex/config.toml'
export const AGENT_SKILL_DIRECTORIES = ['.claude/skills', '.codex/skills'] as const
