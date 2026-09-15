import type { ClientContext } from 'dsh-tauri/client'
import type { ModeSelectProps } from '../components/mode-select.types'
import type { SessionsRuntime, WorkspacesRuntime } from '../service/session-switch.types'
import { defineRegister } from 'dsh-tauri/client'
import { WorktreeModeSelect } from '../components/mode-select'
import { INPUT_DOCK_SLOT, MODE_SELECT_ID, MODE_SELECT_ORDER } from '../constants'
import { locale } from '../locales'

type ModeSelectInjected = Omit<ModeSelectProps, 'useInput' | 'inputActions'>

export const modeSelectFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  controller.add(ctx.slots.inject(INPUT_DOCK_SLOT as never, () =>
    ctx.slots.register(
      {
        name: INPUT_DOCK_SLOT,
        id: MODE_SELECT_ID,
        order: MODE_SELECT_ORDER,
        locale: locale.NS,
        inject: (sessionId: string | undefined): ModeSelectInjected | undefined => sessionId === undefined
          ? undefined
          : {
              sessionId,
              sessionsRuntime: adapter.sessions as unknown as SessionsRuntime,
              workspacesRuntime: adapter.workspaces as unknown as WorkspacesRuntime,
            },
      } as never,
      WorktreeModeSelect,
    )))
})
