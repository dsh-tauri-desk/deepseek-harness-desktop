export interface McpRow {
  id: string
  layer?: 'global' | 'profile'
  shadowed?: boolean
  globalError?: string
  scope?: 'global' | 'profile'
  serverName: string
  transport: 'stdio' | 'streamable-http'
  disabled: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export interface ImportedServerView {
  agent: 'claude-code' | 'codex' | 'cursor' | 'gemini'
  name: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface SkillRepositoryView {
  id: string
  label: string
  kind: 'local' | 'git'
  githubUrl?: string
}

export interface SkillRowView {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean, userInvocable: boolean }
  source: string
  editable: boolean
  removable: boolean
  dir?: string
  policyEditable: boolean
  repository?: SkillRepositoryView
}

export interface SkillsResponse {
  skills: SkillRowView[]
}

export interface SkillContentResponse {
  content: string
}

export interface ActionResult {
  ok: boolean
  error?: string
}

export interface McpSaveResponse {
  ok: boolean
  id: string
}

export interface McpListResponse {
  servers: McpRow[]
  global?: McpRow[]
  profile?: McpRow[]
}

export interface McpConnectivityResponse {
  ok: boolean
  latencyMs?: number
  error?: string
}

export interface McpImportScanResponse {
  servers: ImportedServerView[]
  existing: string[]
}

export interface McpApplyImportResponse {
  ok: boolean
  results: Array<{ name: string, ok: boolean, error?: string }>
}

export type PostSkillSaveBody = Record<string, unknown>

export interface PostSkillDeleteBody {
  name: string
}

export interface PostSkillPolicyBody {
  name: string
  enabled: boolean
}

export interface PostMcpToggleBody {
  id: string
  disabled: boolean
}

export interface PostMcpRemoveBody {
  id: string
}

export interface PostMcpApplyImportBody {
  items: Array<{ agent: string, name: string }>
}
