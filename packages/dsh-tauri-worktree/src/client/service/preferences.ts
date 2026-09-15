import type { WorktreeNewSessionMode } from '../store/modules/worktree.types'
import { createStorage, get, localStorageDriver } from 'dsh-tauri/client'
import { PREFERRED_MODE_STORAGE_KEY, WORKTREE_PLUGIN_NAME } from '../constants'
import { store } from '../store'

const storage = createStorage({ driver: localStorageDriver({ base: WORKTREE_PLUGIN_NAME }) })

export async function loadPreferredMode(): Promise<WorktreeNewSessionMode> {
  if (store.preferences.hydrated)
    return store.preferences.preferredMode
  store.preferences.markHydrated()
  let mode: WorktreeNewSessionMode = 'local'
  try {
    mode = (await storage.getItem(PREFERRED_MODE_STORAGE_KEY)) === 'pending' ? 'pending' : 'local'
  }
  catch {
    mode = 'local'
  }
  store.preferences.setPreferredMode(mode)
  return mode
}

export async function rememberPreferredMode(input: {
  mode: WorktreeNewSessionMode
}): Promise<{ ok: boolean, error?: string }> {
  store.preferences.setPreferredMode(input.mode)
  try {
    await storage.setItem(PREFERRED_MODE_STORAGE_KEY, input.mode)
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: get(error, 'message', String(error)) }
  }
}
