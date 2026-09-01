import type { Context } from '@deepseek-ai/cordis'
import { SettingsSidebar } from '../components/sidebar'
import {
  SETTINGS_REGISTRANT,
  SETTINGS_SHELL_OVERLAY_SLOT,
  SETTINGS_SIDEBAR_ID,
} from '../constants'

/**
 * register/sidebar.ts — shell.overlay 设置侧边栏条目注册。
 *
 * shell.overlay 由 ui-layout 的 AppFrame 声明；alpha 要求注册进入前该槽已
 * 由父条目 children 表声明，故用 inject 等其声明 live 后再注册。
 * @param ctx - 客户端根上下文。
 */
export function registerSettingsSidebar(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.slots.inject(SETTINGS_SHELL_OVERLAY_SLOT, () =>
        ctx.slots.register(
          { name: SETTINGS_SHELL_OVERLAY_SLOT, id: SETTINGS_SIDEBAR_ID, registrant: SETTINGS_REGISTRANT },
          SettingsSidebar,
        )),
    'dsh-tauri-ui: settings sidebar',
  )
}
