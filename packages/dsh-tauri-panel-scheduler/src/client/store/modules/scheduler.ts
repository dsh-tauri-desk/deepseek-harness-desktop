import type { SchedulerUiState } from './scheduler.types'
import { defineStore } from 'dsh-tauri/client'

export const scheduler = defineStore({
  state: (): SchedulerUiState => ({
    tasks: [],
    runs: [],
    options: { workspaces: [], permissions: [], defaultPermission: 'read-only', models: [], failures: [], defaultModel: null },
    loading: false,
    error: '',
    refreshedAt: 0,
    loadToken: 0,
  }),
})
