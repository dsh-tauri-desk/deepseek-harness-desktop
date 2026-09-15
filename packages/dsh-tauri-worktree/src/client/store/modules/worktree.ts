import type { WorktreeSessionState, WorktreeUiState } from './worktree.types'
import { defineStore } from 'dsh-tauri/client'
import { preferences } from './preferences'
import { EMPTY_SESSION_STATE } from './worktree.utils'

export { EMPTY_SESSION_STATE as EMPTY_STATE }

export function blankState(): WorktreeSessionState {
  return { ...EMPTY_SESSION_STATE, mode: preferences.preferredMode }
}

export const worktree = defineStore({
  state: (): WorktreeUiState => ({ bySession: {} }),
  actions: {
    patch(sessionId: string | undefined, patch: Partial<WorktreeSessionState>): void {
      if (sessionId === undefined)
        return
      this.bySession[sessionId] = { ...(this.bySession[sessionId] ?? blankState()), ...patch }
    },
  },
})
