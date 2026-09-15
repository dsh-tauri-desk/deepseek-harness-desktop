import type { WorktreeNewSessionMode } from './worktree.types'
import { defineStore } from 'dsh-tauri/client'

export const preferences = defineStore({
  state: () => ({
    preferredMode: 'local' as WorktreeNewSessionMode,
    hydrated: false,
  }),
  actions: {
    setPreferredMode(mode: WorktreeNewSessionMode): void {
      this.preferredMode = mode
    },
    markHydrated(): void {
      this.hydrated = true
    },
  },
})
