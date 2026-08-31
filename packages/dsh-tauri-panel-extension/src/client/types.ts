import type { ClientContext } from 'dsh-tauri/client'
import type { ComponentType, ReactElement, ReactNode } from 'react'

export interface IconProps {
  size?: number
  className?: string
}

export interface Translate {
  (key: string): string
}

export interface ExtensionLocaleService {
  register: (namespace: string, locale: string, dictionary: Record<string, string>) => () => void
  bind: (namespace: string) => Translate
}

export type ExtensionClientContext = ClientContext & { locale: ExtensionLocaleService }

export interface PanelContentSpec {
  id: string
  render: ComponentType<{ t?: Translate }>
  locale?: string
}

export interface PanelActionItemProps {
  id: string
  icon?: ReactElement
  onClick?: () => void
  children?: ReactNode
}

export interface PanelProtocol {
  ActionItem: (props: PanelActionItemProps) => ReactElement
  renderPanelContent: (spec: PanelContentSpec) => void
  closePanelContent: () => void
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

export interface SkillEditorState {
  mode: 'edit' | 'view'
  name: string
  description: string
  whenToUse: string
  modelInvocable: boolean
  userInvocable: boolean
  content: string
}

export type OpenTarget = { target: 'user-skills' } | { target: 'skill', name: string }

export interface SkillsInjected {
  list: () => Promise<{ skills: SkillRowView[] }>
  get: (name: string) => Promise<{ content: string }>
  save: (input: Record<string, unknown>) => Promise<{ ok: boolean }>
  remove: (name: string) => Promise<{ ok: boolean }>
  policy: (name: string, enabled: boolean) => Promise<{ ok: boolean }>
  open: (target: OpenTarget) => Promise<{ ok: boolean }>
  importRepository: (url: string) => Promise<{ ok: boolean }>
}

export interface SkillsTabProps {
  t: Translate
  injected: SkillsInjected
  createSkill: () => Promise<void>
}

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

export interface InputActions {
  setDraft: (text: string) => void
}

export interface ConversationInputLeftProps {
  sessionId: string
  inputActions: InputActions
}

export interface SessionListSnapshot {
  current?: string
  ids: string[]
}

export interface WorkspaceListItem {
  workspaceId?: string
  id?: string
  sessionIds?: readonly string[]
  updatedAt?: number | string
}

export interface WorkspaceListSnapshot {
  items?: WorkspaceListItem[]
  recentWorkspaceId?: string
}

export interface DesktopBridge {
  restartSidecar?: () => void
}

declare global {
  interface Window {
    dshDesktop?: DesktopBridge
  }
}

export interface ExtensionRuntimeContext {
  sessions: {
    list: { getSnapshot: () => SessionListSnapshot }
    open: (sessionId: string) => void
  }
  workspaces: {
    list: { getSnapshot: () => WorkspaceListSnapshot }
    connectWorkspace: (workspaceId: string) => Promise<string>
  }
}
