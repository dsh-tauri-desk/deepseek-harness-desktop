import type { ClientContext } from 'dsh-tauri/client'
import {
  ARCHIVE_SECTION_EFFECT,
  LOCALE_EFFECT,
  SESSION_PLUGIN_NAME,
  STYLES_EFFECT,
  WORKSPACE_PATCH_EFFECT,
} from './constants'
import { locale } from './locales'
import { archiveSectionFeature } from './register/archive-section'
import { stylesFeature } from './register/styles'
import { workspacePatchFeature } from './register/workspace-patch'

export const name = SESSION_PLUGIN_NAME

export const inject = ['slots', 'locale', 'sessions', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(stylesFeature, STYLES_EFFECT)
  ctx.effect(archiveSectionFeature, ARCHIVE_SECTION_EFFECT)
  ctx.effect(workspacePatchFeature, WORKSPACE_PATCH_EFFECT)
}
