import type { SessionListState } from 'dsh-tauri/client'
import type { SelectorHook } from '../types/selector'

export interface SettingsSidebarProps {
  useSessions: SelectorHook<SessionListState>
  useWorkspaces?: unknown
}
