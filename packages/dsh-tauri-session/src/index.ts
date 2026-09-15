import { SESSION_API_PREFIX, SESSION_PLUGIN_NAME } from './shared/constants'

export const name = SESSION_PLUGIN_NAME

export const inject = ['webServer', 'sessions', 'workspaceRegistry', 'connection']

export const API_PREFIX = SESSION_API_PREFIX

export { apply } from './host/apply'
export { archiveHooks } from './host/events'
export type { ArchiveLifecycleHooks } from './host/events'
