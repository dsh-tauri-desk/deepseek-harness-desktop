import { SCHEDULER_API_PREFIX, SCHEDULER_PLUGIN_NAME } from './shared/constants'

export const name = SCHEDULER_PLUGIN_NAME

export const inject = [
  'tools',
  'webServer',
  'agents',
  'sessions',
  'workspaceRegistry',
  'agentDefaultModel',
  'agentPresets',
  'permissionPresets',
  'llm',
  'connection',
]

export const API_PREFIX = SCHEDULER_API_PREFIX

export { apply } from './host/apply'
export type { Config } from './host/apply'
