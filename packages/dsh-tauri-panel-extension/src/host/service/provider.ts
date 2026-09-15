import { existsSync } from 'node:fs'
import { defineService } from 'dsh-tauri'
import { getCurrentHostInstance, providerRuntime } from '../config/runtime'
import { providerHooks } from '../events'
import { agents } from './agents'
import { loadFilesystemSkillPlugin } from './provider.utils'
import { skillRoot } from './skill-root'

export const provider = defineService({
  start(packagedDir: string): Promise<void> {
    providerRuntime.chain = providerRuntime.chain
      .then(() => remount(packagedDir))
      .catch((error: unknown) => {
        void providerHooks.callHook('provider:error', error)
        const message = error instanceof Error ? error.message : String(error)
        getCurrentHostInstance().logger.error(`dsh-tauri-panel-extension: failed to mount filesystem skill provider: ${message}`)
      })
    return providerRuntime.chain
  },
})

// --- internal ---

async function remount(packagedDir: string): Promise<void> {
  if (providerRuntime.disposed)
    return
  void providerHooks.callHook('provider:before-remount')
  const host = getCurrentHostInstance()
  const plugin = await loadFilesystemSkillPlugin(host.loader)
  if (providerRuntime.fiber !== undefined) {
    const old = providerRuntime.fiber
    providerRuntime.fiber = undefined
    try {
      await old.dispose()
    }
    catch {}
  }
  if (providerRuntime.disposed)
    return
  const roots = [
    packagedDir,
    ...(await skillRoot.list()).flatMap(entry => entry.roots),
    ...agents.peek(),
  ].filter(dir => existsSync(dir))
  try {
    providerRuntime.fiber = host.plugin(plugin, roots.length > 0 ? { customSkillDirs: roots } : {})
    void providerHooks.callHook('provider:after-remount', roots)
  }
  catch (error) {
    void providerHooks.callHook('provider:error', error)
  }
}
