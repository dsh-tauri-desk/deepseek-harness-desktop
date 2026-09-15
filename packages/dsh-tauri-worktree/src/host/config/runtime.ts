import type { HostContext, PendingHandoff } from '../types'
import { defineHostRuntime } from 'dsh-tauri'

export const { setCurrentHostInstance, getCurrentHostInstance } = defineHostRuntime<HostContext>()

export const pendingHandoffs = new Map<string, PendingHandoff>()

export const injectedCheckoutContexts = new Set<string>()

export function clearHostRuntime(): void {
  pendingHandoffs.clear()
  injectedCheckoutContexts.clear()
  setCurrentHostInstance(undefined)
}
