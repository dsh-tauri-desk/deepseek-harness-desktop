import { defineConfig } from '@genapi/core'
import { pluginPipeline } from './genapi.pipeline'

const plugins = [
  'dsh-tauri-panel-extension',
  'dsh-tauri-panel-scheduler',
  'dsh-tauri-rightclick',
  'dsh-tauri-session',
  'dsh-tauri-turnrewind',
  'dsh-tauri-worktree',
]

const servers = plugins.map(plugin => ({
  output: { main: `packages/${plugin}/src/client/apis/index.ts` },
  server: { routes: `packages/${plugin}/src/host/routes`, plugin },
}))

export default defineConfig({
  preset: pluginPipeline,
  servers: servers as any[],
})
