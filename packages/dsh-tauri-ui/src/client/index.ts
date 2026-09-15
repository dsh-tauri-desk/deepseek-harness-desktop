import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_NAME } from '../shared/constants'
import {
  LOCALE_EFFECT,
  OBSTRUCTIONS_EFFECT,
  SEAT_EFFECT,
  SECTIONS_EFFECT,
  SETTINGS_EFFECT,
  STYLES_EFFECT,
} from './constants'
import { locale } from './locales'
import { registerSettingsObstructions } from './register/obstructions'
import { registerShellSeat } from './register/seat'
import { registerSettingsSections } from './register/sections'
import { registerSettings } from './register/settings'
import { registerStyles } from './register/styles'

export * from './components'
export type * from './components/menu-select.types'
export type * from './components/sidebar.types'
export type * from './components/trigger.types'
export * from './constants/theme'
export * from './hooks/use-mount-style'
export type * from './store/modules/sections.types'
export type * from './store/modules/settings.types'
export type * from './types/sections'
export type * from './types/selector'
export * from './utils/cssr'
export * from './utils/style'

export const name = PLUGIN_NAME
export const inject = ['slots', 'layout', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(registerStyles, STYLES_EFFECT)
  ctx.effect(registerShellSeat, SEAT_EFFECT)
  ctx.effect(registerSettingsSections, SECTIONS_EFFECT)
  ctx.effect(registerSettings, SETTINGS_EFFECT)
  ctx.effect(registerSettingsObstructions, OBSTRUCTIONS_EFFECT)
}
