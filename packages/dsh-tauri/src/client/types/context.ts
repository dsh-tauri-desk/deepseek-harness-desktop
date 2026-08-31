import type { Context } from '@deepseek-ai/cordis'
import type { ILayout, LocaleService } from './inject'

/** Cordis context with the client services consumed by the Tauri plugins. */
export type ClientContext = Context & {
  locale: LocaleService
  layout: ILayout
}
