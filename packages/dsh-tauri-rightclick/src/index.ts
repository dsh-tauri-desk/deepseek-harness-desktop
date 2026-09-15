import { RIGHTCLICK_API_PREFIX, RIGHTCLICK_PLUGIN_NAME } from './shared/constants'

export const name = RIGHTCLICK_PLUGIN_NAME

export const inject = ['webServer', 'connection']

export const API_PREFIX = RIGHTCLICK_API_PREFIX

export { apply } from './host/apply'
