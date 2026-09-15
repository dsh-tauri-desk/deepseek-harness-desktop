import type { HostContext } from '../types'
import { defineHostRuntime } from 'dsh-tauri'

export const { setCurrentHostInstance, getCurrentHostInstance } = defineHostRuntime<HostContext>()

export function clearHostRuntime(): void {
  setCurrentHostInstance(undefined)
}
