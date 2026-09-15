import { useStore } from 'dsh-tauri/client'
import { store } from '../store'

export function useScheduler() {
  return useStore(store.scheduler)
}
