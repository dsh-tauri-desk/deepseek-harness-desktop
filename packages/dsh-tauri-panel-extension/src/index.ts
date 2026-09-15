import { PLUGIN_NAME } from './shared/constants'

export const name = PLUGIN_NAME

export const inject = ['webServer', 'skills', 'connection']

export { apply, loadFilesystemSkillPlugin, packagedSkillsDir } from './host/apply'
export type { Config } from './host/apply'
export { providerHooks } from './host/events'
export type { ProviderLifecycleHooks } from './host/events'
export { routes } from './host/routes'
export type { ExtensionRouteDeps } from './host/routes/index.types'
