import type { ProviderRuntime } from '../service/provider.types'
import type { PanelExtensionHost } from './runtime.types'
import { defineHostRuntime } from 'dsh-tauri'

export const { setCurrentHostInstance, getCurrentHostInstance } = defineHostRuntime<PanelExtensionHost>()

export const providerRuntime: ProviderRuntime = {
  fiber: undefined,
  chain: Promise.resolve(),
  disposed: false,
}

export function resetProviderRuntime(): void {
  providerRuntime.fiber = undefined
  providerRuntime.chain = Promise.resolve()
  providerRuntime.disposed = false
}

export function clearHostRuntime(): void {
  providerRuntime.fiber = undefined
  providerRuntime.chain = Promise.resolve()
  providerRuntime.disposed = true
  setCurrentHostInstance(undefined)
}
