import type { ClientContext } from 'dsh-tauri/client'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
import { defineRegister } from 'dsh-tauri/client'
import { SettingsSidebar } from '../components/sidebar'
import { SettingsTrigger } from '../components/trigger'
import {
  SETTINGS_REGISTRANT,
  SETTINGS_SHELL_OVERLAY_SLOT,
  SETTINGS_SIDEBAR_ID,
  SETTINGS_SIDEBAR_SLOT,
  SETTINGS_TRIGGER_PRIORITY,
} from '../constants'

export const registerSettings = defineRegister<ClientContext>((controller, ctx) => {
  if (typeof SlotOutlet !== 'function') {
    console.warn(
      '[dsh-tauri-ui] <SlotOutlet> unavailable (renderer patch missing) — settings sidebar disabled, official dialog stays.',
    )
    return
  }

  controller.add(
    ctx.slots.inject(SETTINGS_SHELL_OVERLAY_SLOT, () =>
      ctx.slots.register(
        { name: SETTINGS_SHELL_OVERLAY_SLOT, id: SETTINGS_SIDEBAR_ID, registrant: SETTINGS_REGISTRANT, inject: () => ({}) } as never,
        SettingsSidebar as never,
      )),
  )
  controller.add(
    ctx.slots.inject(SETTINGS_SIDEBAR_SLOT as never, () =>
      ctx.slots.register(
        { name: SETTINGS_SIDEBAR_SLOT, priority: SETTINGS_TRIGGER_PRIORITY, registrant: SETTINGS_REGISTRANT } as never,
        SettingsTrigger,
      )),
  )
})
