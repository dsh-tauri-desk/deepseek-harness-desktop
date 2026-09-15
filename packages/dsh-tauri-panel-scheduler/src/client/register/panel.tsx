import type { ClientContext, PanelHandle } from 'dsh-tauri/client'
import type { Translate } from '../locales/index.types'
import { Calendar, Icon, PanelWidthSync } from 'dsh-tauri-ui/client'
import { definePanel, defineRegister } from 'dsh-tauri/client'
import { SchedulerPanel } from '../components/scheduler-panel'
import { PANEL_ACTION_ORDER, PANEL_ID } from '../constants'
import { locale } from '../locales'
import { store } from '../store'

export const panelFeature = defineRegister<ClientContext>((controller, ctx) => {
  const t: Translate = locale.text
  const holder: { current?: PanelHandle } = {}

  holder.current = definePanel(ctx, {
    id: PANEL_ID,
    order: PANEL_ACTION_ORDER,
    locale: locale.NS,
    label: () => locale.text('scheduler'),
    icon: props => <Icon as={Calendar} size={props.size} />,
    render: () => (
      <PanelWidthSync>
        <SchedulerPanel
          t={t}
          onViaChat={() => {
            store.prefill.set(locale.text('chatPrompt'))
            holder.current?.close()
          }}
        />
      </PanelWidthSync>
    ),
  })
  controller.add(holder.current.dispose)
})
