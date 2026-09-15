import { WORKTREE_API_PREFIX, WORKTREE_PLUGIN_NAME } from './shared/constants'

export const name = WORKTREE_PLUGIN_NAME

export const inject = ['tools', 'systemPrompt', 'webServer', 'sessions', 'workspaceRegistry', 'agents', 'connection']

export const API_PREFIX = WORKTREE_API_PREFIX

export { apply } from './host/apply'
