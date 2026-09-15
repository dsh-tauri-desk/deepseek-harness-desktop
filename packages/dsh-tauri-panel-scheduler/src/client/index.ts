import type { ClientContext } from 'dsh-tauri/client'
import {
  HYDRATE_EFFECT,
  LOCALE_EFFECT,
  PANEL_EFFECT,
  PLUGIN_ID,
  PREFILL_EFFECT,
  SESSION_ICONS_EFFECT,
  STYLES_EFFECT,
} from './constants'
import { locale } from './locales'
import { hydrateFeature } from './register/hydrate'
import { panelFeature } from './register/panel'
import { prefillFeature } from './register/prefill'
import { sessionIconsFeature } from './register/session-icons'
import { stylesFeature } from './register/styles'

export const name = PLUGIN_ID

export const inject = ['slots', 'layout', 'locale', 'sessions', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(stylesFeature, STYLES_EFFECT)
  ctx.effect(hydrateFeature, HYDRATE_EFFECT)
  ctx.effect(panelFeature, PANEL_EFFECT)
  ctx.effect(prefillFeature, PREFILL_EFFECT)
  ctx.effect(sessionIconsFeature, SESSION_ICONS_EFFECT)
}
