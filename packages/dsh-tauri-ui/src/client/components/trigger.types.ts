import type { SessionListState } from 'dsh-tauri/client'
import type { SelectorHook } from '../types/selector'

export interface SettingsTriggerProps {
  wide: boolean
  useSessions: SelectorHook<SessionListState>
  useWorkspaces?: unknown
}
