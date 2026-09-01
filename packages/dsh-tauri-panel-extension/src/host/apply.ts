/**
 * dsh-tauri-panel-extension host entry: mount the manager's HTTP routes once
 * the profile composes both the web server and the skill registry, and mount
 * a host-plane filesystem skill provider so the Settings page sees a live
 * catalog (the web composition deliberately leaves the host row to presets).
 * The provider's custom roots also take the user-registered skill
 * repositories from the plugin state file, and remount whenever those
 * change — the catalog follows without a dsh restart.
 *
 * provider 重挂载是状态机轴：before/after/error 钩子经 host/hooks.ts 的
 * providerHooks（hookable）暴露，供诊断与第三方联动。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PanelExtensionHost } from './types.js'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'pathe'
import { PLUGIN_NAME } from '../shared/constants.js'
import { agentSkillRoots } from './agents.js'
import { providerHooks } from './hooks.js'
import { argvProfile, profileDir } from './profile.js'
import { mountPanelExtensionRoutes } from './routes.js'
import { loadState } from './state.js'

export const name = PLUGIN_NAME

/**
 * The package's own vendored skills (`skills/` at the package root — resolves
 * identically from src/ under vitest and from lib/ when installed). Scanned as
 * a custom root, so every session sees them through the registry's global
 * layer while the files stay zero-copy and travel with plugin installs.
 */
export function packagedSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}

/** Optional cordis.yml configuration; profile defaults to the booted one. */
export interface Config {
  /** Profile whose patch layer holds the MCP rows; defaults to argv or `web`. */
  profile?: string
}

export const inject = ['webServer', 'skills', 'connection']

/** The provider plugin's structural shape (name/apply export). */
interface FilesystemSkillPlugin {
  name: string
  apply: (context: Context, config?: unknown) => void
}

/** Platform loader subset used to resolve DSH-owned packages from its base URL. */
interface PlatformPluginLoader {
  import: (name: string) => Promise<unknown>
  unwrapExports: (exports: unknown) => unknown
}

export async function loadFilesystemSkillPlugin(loader: PlatformPluginLoader): Promise<FilesystemSkillPlugin> {
  return loader.unwrapExports(
    await loader.import('@deepseek-ai/dsh-skill-filesystem'),
  ) as FilesystemSkillPlugin
}

/** The disposable fiber `ctx.plugin()` returns, as far as we use it. */
interface PluginFiber {
  dispose: () => Promise<void>
}

export function apply(ctx: Context, config?: Config): void {
  const profile = config?.profile ?? argvProfile() ?? 'web'
  ctx.inject(['webServer', 'skills', 'connection'], (hostCtx: Context) => {
    // The web bundle disables the host-plane `skill-filesystem` row on
    // purpose (presets own per-session discovery). The Settings manager
    // mounts its own host-plane provider as a CHILD of this plugin: it dies
    // with us, registers into the registry's global layer (deployment-level
    // providers are exactly what that layer is for — agents read the merged
    // catalog), and preset layers keep their semantics (nearest layer still
    // wins duplicate names). Custom roots, in scan order: the package's own
    // vendored skills (read-only, update with the plugin), the user's
    // registered repositories (local paths and GitHub checkouts, managed
    // from the Settings page), then other agents' skill roots
    // (~/.claude/skills, ~/.codex/skills) — zero-copy, live-synced both
    // ways. Registering or removing a repository remounts the provider with
    // the new root set; a failed load only means an empty catalog — the
    // routes keep serving.
    let providerFiber: PluginFiber | undefined
    let disposed = false
    ctx.effect(() => {
      const disposer = (): void => {
        disposed = true
      }
      let chain: Promise<void> = Promise.resolve()
      const remountProvider = (): Promise<void> => {
        // Serialize remounts; concurrent add/remove requests must not
        // interleave dispose and re-plugin on the same provider.
        chain = chain.then(async () => {
          if (disposed)
            return
          void providerHooks.callHook('provider:before-remount')
          // Internal Desktop plugins are linked from a resource directory with
          // no node_modules. Resolve DSH-owned packages through the platform
          // loader (the same path used by preset rows), not native ESM relative
          // to this linked plugin's real path.
          const loader = (hostCtx as Context & { loader: PlatformPluginLoader }).loader
          const plugin = await loadFilesystemSkillPlugin(loader)
          if (providerFiber !== undefined) {
            const old = providerFiber
            providerFiber = undefined
            try {
              await old.dispose()
            }
            catch {
              /* unloading raced us */
            }
          }
          if (disposed)
            return
          const roots = [
            packagedSkillsDir(),
            ...loadState().skillRoots.flatMap(entry => entry.roots),
            ...agentSkillRoots(),
          ].filter(dir => existsSync(dir))
          try {
            providerFiber = hostCtx.plugin(plugin, roots.length > 0 ? { customSkillDirs: roots } : {}) as PluginFiber
            void providerHooks.callHook('provider:after-remount', roots)
          }
          catch (error) {
            // Context already disposed: nothing left to mount for.
            void providerHooks.callHook('provider:error', error)
          }
        })
        chain = chain.catch((error: unknown) => {
          // A missing runtime provider dependency previously degraded into a
          // healthy empty catalog in packaged Desktop builds. Keep routes
          // available, but surface the actual initialization failure.
          void providerHooks.callHook('provider:error', error)
          hostCtx.logger.error(
            `dsh-tauri-panel-extension: failed to mount filesystem skill provider: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        return chain
      }
      void remountProvider()

      ctx.effect(
        () => mountPanelExtensionRoutes(hostCtx as unknown as PanelExtensionHost, {
          profileDirPath: profileDir(profile),
          remountProvider,
        }),
        'dsh-tauri-panel-extension: http routes',
      )
      return disposer
    }, 'dsh-tauri-panel-extension: skill provider')
  })
}
