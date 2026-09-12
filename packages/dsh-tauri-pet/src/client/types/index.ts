/** Shared client types for pet settings and raw session forwarding. */
export interface PetStatus {
  active_pet: string
  enabled: boolean
  pet_size?: number | null
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

/**
 * 预设宠物清单条目（`resources/preset-pets.json` 的展示层投影）。
 *
 * 预设不再下载/安装：清单里的条目本身就是桌宠组件的渲染参数（`config` / `uri` /
 * `ext` 等由 pet 窗口直接消费），设置页只需要展示字段，因此这里只声明投影形状，
 * Rust 返回的其余字段前端原样忽略。
 */
export interface PresetPetItem {
  desc?: string | null
  id: string
  image?: string | null
  kind?: 'dsh' | 'codex' | null
  name: string
  size?: number | null
}

export interface WorkspaceItem {
  id?: string
  sessionIds?: readonly string[]
  workspaceId?: string
}

export interface PetRuntimeContext {
  sessions: {
    list: {
      getSnapshot: () => {
        current?: string
        ids: readonly string[]
      }
    }
    open?: (id: string) => void
  }
  workspaces: {
    connectWorkspace?: (id: string) => Promise<string>
    list: {
      getSnapshot: () => {
        items?: WorkspaceItem[]
        recentWorkspaceId?: string
      }
    }
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
  = | 'clear'
    | 'clearFailed'
    | 'closePet'
    | 'create'
    | 'createFailed'
    | 'emptyImported'
    | 'enable'
    | 'enablePet'
    | 'import'
    | 'importFailed'
    | 'listFailed'
    | 'loading'
    | 'name'
    | 'select'
    | 'setPetFailed'
    | 'setSizeFailed'
    | 'sizeHint'
    | 'sizeLabel'
    | 'tabCodexDesc'
    | 'tabInstalledDesc'
    | 'toggleFailed'
