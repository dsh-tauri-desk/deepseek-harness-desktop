/**
 * register/panel.ts — 调度器面板的 slot 注册（sidebar.panel.action）。
 *
 * 注册逻辑与组件分离：这里只负责「等 panel.protocol 就绪 → 注册 ActionItem /
 * 内容替换视图」，含 50ms 重试等待。UI 在 components/scheduler-panel.tsx。
 */

import type { ClientContext } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import type { PanelProtocol, Translate } from '../types'
import { IconSchedule } from '../components/icons'
import { SchedulerPanel } from '../components/scheduler-panel'
import {
  LOCALE_NAMESPACE,
  PANEL_ACTION_ID,
  PANEL_ACTION_ORDER,
  PANEL_ACTION_PRIORITY,
  PANEL_ID,
  PANEL_PROTOCOL_NAME,
  PANEL_SLOT_NAME,
  PLUGIN_ID,
  PROTOCOL_RETRY_MS,
} from '../constants'
import { setChatPrefill } from '../prefill'
import { hydrateScheduler } from '../store'

export function installSchedulerPanel(ctx: ClientContext, t: Translate): void {
  ctx.slots.inject(PANEL_SLOT_NAME as never, () => {
    let registration: (() => void) | undefined
    let retryTimer: number | undefined

    const attemptRegistration = (): void => {
      if (registration)
        return
      const protocol = ctx.reflect.get(PANEL_PROTOCOL_NAME) as PanelProtocol | undefined
      if (!protocol)
        return
      // 「通过 Chat 创建」：照搬 dsh-automation 的 setChatPrefill + 关闭设置/面板。
      const Content = (): ReactElement => (
        <SchedulerPanel
          t={t}
          onViaChat={() => {
            setChatPrefill(t('chatPrompt'))
            protocol.closePanelContent?.()
          }}
        />
      )
      const Action = (): ReactElement => <protocol.ActionItem id={PANEL_ID} icon={<IconSchedule />} onClick={() => protocol.renderPanelContent?.({ id: PANEL_ID, render: Content, locale: LOCALE_NAMESPACE })}>{t('scheduler')}</protocol.ActionItem>
      registration = ctx.slots.register({ name: PANEL_SLOT_NAME, id: PANEL_ACTION_ID, registrant: PLUGIN_ID, order: PANEL_ACTION_ORDER, priority: PANEL_ACTION_PRIORITY, locale: LOCALE_NAMESPACE, inject: () => ({}) } as never, Action)
      if (retryTimer !== undefined) {
        window.clearInterval(retryTimer)
        retryTimer = undefined
      }
      void hydrateScheduler()
    }

    attemptRegistration()
    if (!registration)
      retryTimer = window.setInterval(attemptRegistration, PROTOCOL_RETRY_MS)
    return () => {
      if (retryTimer !== undefined)
        window.clearInterval(retryTimer)
      registration?.()
    }
  })
}
