import type { ClientContext } from 'dsh-tauri/client'
import {
  DIALOG_EFFECT,
  HYDRATION_EFFECT,
  LOCALE_EFFECT,
  MODE_SELECT_EFFECT,
  PREFERENCES_EFFECT,
  SESSION_ICONS_EFFECT,
  STYLES_EFFECT,
  SURFACE_EFFECT,
  WORKTREE_PLUGIN_NAME,
} from './constants'
import { locale } from './locales'
import { dialogFeature } from './register/dialog'
import { hydrationFeature } from './register/hydration'
import { modeSelectFeature } from './register/mode-select'
import { preferencesFeature } from './register/preferences'
import { sessionIconsFeature } from './register/session-icons'
import { stylesFeature } from './register/styles'
import { surfaceFeature } from './register/surface'

export { WORKTREE_API_PREFIX } from '../shared/constants'
export type * from './apis/index.type'
export type * from './store/modules/worktree.types'

export const name = WORKTREE_PLUGIN_NAME

export const inject = ['slots', 'layout', 'locale', 'sessions', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(preferencesFeature, PREFERENCES_EFFECT)
  ctx.effect(stylesFeature, STYLES_EFFECT)
  ctx.effect(modeSelectFeature, MODE_SELECT_EFFECT)
  ctx.effect(surfaceFeature, SURFACE_EFFECT)
  ctx.effect(dialogFeature, DIALOG_EFFECT)
  ctx.effect(hydrationFeature, HYDRATION_EFFECT)
  ctx.effect(sessionIconsFeature, SESSION_ICONS_EFFECT)
}
