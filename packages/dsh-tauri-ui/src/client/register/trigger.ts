import type { Context } from '@deepseek-ai/cordis'
import { SettingsTrigger } from '../components/trigger'
import {
  SETTINGS_REGISTRANT,
  SETTINGS_SIDEBAR_SLOT,
  SETTINGS_TRIGGER_PRIORITY,
} from '../constants'

/**
 * register/trigger.ts — sidebar.settings 触发条目注册（priority -1 shadow 官方）。
 *
 * 'sidebar.settings' 不属于本插件类型图的 SlotMap 键（声明权在 ui-sidebar，
 * 类型未提升到根 node_modules），此处对 options 显式 cast 以通过 K 收窄；
 * 组件 props 仍由本地 SettingsTriggerProps 提供类型保证。
 * @param ctx - 客户端根上下文。
 */
export function registerSettingsTrigger(ctx: Context): void {
  ctx.slots.inject(SETTINGS_SIDEBAR_SLOT as never, () =>
    ctx.slots.register(
      { name: SETTINGS_SIDEBAR_SLOT, priority: SETTINGS_TRIGGER_PRIORITY, registrant: SETTINGS_REGISTRANT } as never,
      SettingsTrigger,
    ))
}
