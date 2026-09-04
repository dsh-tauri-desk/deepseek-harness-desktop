/** Shared client types for the pet settings, bridge, and session activity. */
export type PetActivity = 'failed' | 'idle' | 'moving-left' | 'moving-right' | 'review' | 'running' | 'turn' | 'waiting' | 'waving'

/** Session states selected by the activity adapter before native animation details. */
export type PetSessionActivity = Extract<PetActivity, 'failed' | 'idle' | 'review' | 'running' | 'waiting'>

/**
 * Single session projection pushed to the pet window.
 *
 * - `bubble`   — 固定标题（会话名/展示名），创建 toast 时写入，之后不随状态变化。
 * - `description` — 实时描述（思考 / 工具 + 工具名 / 需决策 / 待审阅 / 失败…），
 *                  每次状态推进都更新，驱动 toast 的 description 槽原地刷新。
 */
export interface PetSessionStatus {
  activity: PetSessionActivity
  bubble?: string | null
  description?: string | null
  id: string
}

export interface PetStatus {
  active_pet: string
  activity: PetActivity
  bubble?: string | null
  enabled: boolean
  pet_size?: number | null
  sessions?: PetSessionStatus[]
  visible: boolean
}

export type PetSource = 'chat' | 'codex'

export interface PetListItem {
  description?: string
  id: string
  name: string
  source: PetSource
  thumbnail?: string
}

export interface PetAsset {
  columns: number
  id: string
  rows: number
  sprite_version_number: number
  spritesheet: string
}

export interface PetSessionSummary {
  completed?: boolean
  displayTitle?: string
  id: string
  pendingInteraction?: unknown
  running?: boolean
  title?: string
}

export interface PetSessionSnapshot {
  awaitingFirstTurn?: boolean
  lastAgentError?: string | null
  pendingSubmissions?: readonly unknown[]
  queue?: readonly unknown[]
  running?: boolean
}

export interface PetObservable<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

/** A single session event that can fall through the session event window. */
export interface PetSessionEvent {
  data?: Record<string, unknown>
  seq?: number
  type?: string
}

/** Session event window snapshot exposed by `eventSource.getSnapshot()`. */
export interface PetSessionEventWindow {
  change?: { kind?: string, entries?: PetSessionEvent[] }
  entries?: PetSessionEvent[]
  hasMore?: boolean
  revision?: number
}

export interface PetSessionsRuntime {
  binding?: (id: string) => {
    eventSource?: PetObservable<PetSessionEventWindow>
    session?: PetObservable<PetSessionSnapshot>
  } | undefined
  list: PetObservable<{
    byId?: Record<string, PetSessionSummary>
    current?: string
    ids: string[]
  }>
  open?: (id: string) => void
}

export interface WorkspaceItem {
  id?: string
  sessionIds?: readonly string[]
  workspaceId?: string
}

export interface PetRuntimeContext {
  sessions: PetSessionsRuntime
  uiSession?: {
    pendingInteractions?: PetObservable<ReadonlyMap<string, unknown>>
  }
  workspaces: {
    connectWorkspace?: (id: string) => Promise<string>
    list: PetObservable<{
      items?: WorkspaceItem[]
      recentWorkspaceId?: string
    }>
  }
}

export interface PetSettingsProps {
  close?: () => void
  onCreate: (close?: () => void) => Promise<void>
}

export interface ConversationInputLeftProps {
  inputActions: {
    setDraft: (text: string) => void
  }
  sessionId: string
}

export type LocaleKey
  = | 'activityApproval'
    | 'activityFailed'
    | 'activityIdle'
    | 'activityLimit'
    | 'activityPreparing'
    | 'activityResult'
    | 'activityReview'
    | 'activityRunning'
    | 'activityStopped'
    | 'activityThinking'
    | 'activityWaiting'
    | 'activityWorking'
    | 'codex'
    | 'collapsePet'
    | 'create'
    | 'createFailed'
    | 'emptyImported'
    | 'import'
    | 'importFailed'
    | 'listFailed'
    | 'name'
    | 'pendingPlanReview'
    | 'pendingQuestion'
    | 'petDescWhale'
    | 'petNameWhale'
    | 'select'
    | 'selected'
    | 'setPetFailed'
    | 'setSizeFailed'
    | 'sizeHint'
    | 'sizeLabel'
    | 'tabCodexDesc'
    | 'tabInstalledDesc'
    | 'toggleFailed'
    | 'toolPrefix'
    | 'wakePet'
