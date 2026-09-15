import type { SettingsUiState } from './settings.types'
import { defineStore } from 'dsh-tauri/client'

export const settings = defineStore({
  state: (): SettingsUiState => ({
    open: false,
    activeId: undefined,
    query: '',
    railWidth: undefined,
  }),
  actions: {
    openAt(sectionId?: string) {
      this.open = true
      if (sectionId !== undefined)
        this.activeId = sectionId
    },
    close() {
      this.open = false
      this.activeId = undefined
      this.query = ''
      this.railWidth = undefined
    },
    select(id: string) {
      this.activeId = id
    },
    setQuery(query: string) {
      this.query = query
    },
    setRailWidth(px: number) {
      this.railWidth = px
    },
  },
})
