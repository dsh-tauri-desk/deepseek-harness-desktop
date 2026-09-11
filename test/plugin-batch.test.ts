import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const configPluginSource = readFileSync(
  new URL('../src/components/config-plugin.tsx', import.meta.url),
  'utf8',
)
const batchDialogSource = readFileSync(
  new URL('../src/components/plugin-batch-dialog.tsx', import.meta.url),
  'utf8',
)
const configDialogSource = readFileSync(
  new URL('../src/components/config-dialog.tsx', import.meta.url),
  'utf8',
)
const watchSource = readFileSync(
  new URL('../src-tauri/src/service/plugin/watch.rs', import.meta.url),
  'utf8',
)
const coreSource = readFileSync(
  new URL('../src-tauri/src/service/core/source.rs', import.meta.url),
  'utf8',
)

describe('plugin batch management frontend contract', () => {
  it('offers disable, enable, uninstall, and upgrade actions', () => {
    expect(configPluginSource).toContain('onBatchAction(\'disable\')')
    expect(configPluginSource).toContain('onBatchAction(\'enable\')')
    expect(configPluginSource).toContain('onBatchAction(\'remove\')')
    expect(configPluginSource).toContain('onBatchAction(\'update\')')
    expect(configPluginSource).toContain('PluginBatchDialog')
  })

  it('excludes built-in plugins from batch selection and actions', () => {
    expect(configPluginSource).toContain('const selectablePlugins = plugins.filter(plugin => !plugin.internal)')
    expect(configPluginSource).toContain('plugins.filter(plugin => !plugin.internal).map(plugin => plugin.id)')
    expect(configPluginSource).toContain('isDisabled={controlsDisabled || plugin.internal}')
    expect(configPluginSource).toContain('!plugin.internal && selectedIds.has(plugin.id)')
  })

  it('uses deterministic bundled-first and id ordering for plugin rows', () => {
    expect(configPluginSource).toContain('const sortedPlugins = [...plugins].sort((a, b) => {')
    expect(configPluginSource).toContain('if (a.bundled !== b.bundled)')
    expect(configPluginSource).toContain('return a.bundled ? -1 : 1')
    expect(configPluginSource).toContain('if (a.id < b.id)')
    expect(configPluginSource).toContain('{displayedPlugins.map(plugin => (')
  })

  it('hides built-in plugins by default and exposes an opt-in toggle', () => {
    expect(configPluginSource).toContain('const [showBuiltInPlugins, setShowBuiltInPlugins] = useState(false)')
    expect(configPluginSource).toContain('const displayedPlugins = showBuiltInPlugins')
    expect(configPluginSource).toContain('sortedPlugins.filter(plugin => !plugin.internal)')
    expect(configPluginSource).toContain('t(\'plugins.show_builtin\')')
    expect(configPluginSource).toContain('{displayedPlugins.map(plugin => (')
  })

  it('opens a plugin repository from its name when a URL is available', () => {
    expect(configPluginSource).toContain('plugin.repo_url !== \'\'')
    expect(configPluginSource).toContain('invoke(\'open_external_url\', { url: plugin.repo_url })')
  })

  it('runs each selected plugin before the single completion callback', () => {
    expect(batchDialogSource).toContain('for (const plugin of props.plugins)')
    expect(batchDialogSource).toContain('await props.runAction(plugin)')
    expect(batchDialogSource).toContain('await props.completeBatch(restartNow)')
    expect(batchDialogSource).toContain('plugins.batch_close_later')
    expect(batchDialogSource).toContain('plugins.batch_restart_now')
    expect(configPluginSource).toContain('completeBatch: async (restartNow)')
    expect(configPluginSource).toContain('await store.harness.restart()')
  })

  it('blocks closing while operations or the restart are still running', () => {
    expect(batchDialogSource).toContain('!finished || finalizing')
    expect(configDialogSource).toContain('pluginBatchRunningRef')
    expect(configDialogSource).toContain('onOpenChange={handleOpenChange}')
  })

  it('wires plugin support declarations to the incompatibility hint', () => {
    expect(watchSource).toContain('active_engine_version(app_handle)')
    expect(watchSource).not.toContain('active_version(app_handle)')
    expect(coreSource).toContain('dsh_engine_version_from_binary')
    expect(coreSource).toContain('package_dir.join("package.json")')
    expect(watchSource).toContain('dsh_compatible')
    expect(configPluginSource).toContain('plugin.dshCompatible === false')
    expect(configPluginSource).toContain('plugins.incompatible_hint')
  })
})

describe('plugin batch management i18n contract', () => {
  const keys = [
    'plugins.batch_select_all',
    'plugins.batch_selected',
    'plugins.batch_processing',
    'plugins.batch_finished',
    'plugins.batch_result_count',
    'plugins.batch_finishing',
    'plugins.batch_restarting',
    'plugins.batch_restart_failed',
    'plugins.batch_close_later',
    'plugins.batch_restart_now',
    'plugins.batch_remove_confirm_title',
    'plugins.batch_enable_override_confirm_title',
    'plugins.incompatible_hint',
    'plugins.show_builtin',
    'plugins.no_visible',
  ]

  it.each(['en-US', 'zh-CN'])('provides all batch messages in %s', (locale) => {
    const source = readFileSync(
      new URL(`../src/i18n/locales/${locale}.json`, import.meta.url),
      'utf8',
    )
    const messages = JSON.parse(source) as Record<string, string>
    for (const key of keys)
      expect(messages).toHaveProperty(key)
  })
})
