/** types/mcp.ts — MCP 服务器管理领域类型（McpTab 相关）。 */

import type { Translate } from './protocol'

export interface McpRow {
  id: string
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
  agent: 'claude-code' | 'codex'
  name: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface McpInjected {
  list: () => Promise<{ servers: McpRow[] }>
  save: (input: Record<string, unknown>) => Promise<{ ok: boolean, id: string }>
  toggle: (id: string, disabled: boolean) => Promise<{ ok: boolean }>
  remove: (id: string) => Promise<{ ok: boolean }>
  scanImport: () => Promise<{ servers: ImportedServerView[], existing: string[] }>
  applyImport: (items: Array<{ agent: string, name: string }>) => Promise<{ ok: boolean, results: Array<{ name: string, ok: boolean, error?: string }> }>
  restart: () => Promise<void>
  desktop: boolean
}

export type McpEditorMode = 'json' | 'form'

export interface McpEditorState {
  id: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command: string
  args: string
  env: string
  url: string
  headers: string
}

export interface McpImportItem {
  server: ImportedServerView
  existing: boolean
  checked: boolean
}

export interface ParsedMcpJson {
  serverName?: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface McpTabProps {
  t: Translate
  injected: McpInjected
}
