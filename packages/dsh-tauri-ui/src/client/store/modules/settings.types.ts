export interface SettingsUiState {
  open: boolean
  activeId: string | undefined
  query: string
  railWidth: number | undefined
}

export type SettingsUiKey = 'back' | 'search' | 'settings' | 'noResults'
