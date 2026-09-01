/**
 * register/extension-panel.ts — 扩展面板的 slot 注册（sidebar.panel.action）。
 *
 * 注册逻辑与组件分离：这里只负责「等 panel.protocol 就绪 → 注册 ActionItem /
 * 内容替换视图」，含 50ms 重试等待。UI 在 components/extension-panel.tsx。
 */

import type { ClientContext } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import type { ExtensionRuntimeContext, McpInjected, PanelProtocol, SkillsInjected, Translate } from '../types'
import { compat } from 'dsh-tauri/client'
import { ExtensionPanel } from '../components/extension-panel'
import { IconExtension } from '../components/icons'
import { pendingPrefills } from '../config'
import {
  LOCALE_NAMESPACE,
  PANEL_ACTION_ID,
  PANEL_ACTION_ORDER,
  PANEL_ACTION_PRIORITY,
  PANEL_ID,
  PANEL_PROTOCOL_NAME,
  PANEL_SLOT_NAME,
  PLUGIN_ID,
} from '../constants'
import { chooseWorkspace } from '../utils/workspace'

export function installExtensionPanel(ctx: ClientContext, t: Translate, skills: SkillsInjected, mcp: McpInjected): void {
  ctx.slots.inject(PANEL_SLOT_NAME as never, () => {
    let registration: (() => void) | undefined
    let retryTimer: number | undefined

    const attemptRegistration = (): void => {
      if (registration)
        return
      const protocol = ctx.reflect.get(PANEL_PROTOCOL_NAME) as PanelProtocol | undefined
      if (!protocol)
        return
      const runtime = compat(ctx) as unknown as ExtensionRuntimeContext
      const createSkill = async (): Promise<void> => {
        const id = chooseWorkspace(runtime)
        if (id === undefined)
          throw new Error(t('workspaceUnavailable'))
        const sessionId = await runtime.workspaces.connectWorkspace?.(id)
        if (!sessionId)
          throw new Error(t('workspaceUnavailable'))
        pendingPrefills.add(sessionId)
        protocol.closePanelContent()
        runtime.sessions.open(sessionId)
      }
      const Content = (): ReactElement => <ExtensionPanel t={t} skills={skills} mcp={mcp} createSkill={createSkill} />
      const Action = (): ReactElement => <protocol.ActionItem id={PANEL_ID} icon={<IconExtension />} onClick={() => protocol.renderPanelContent({ id: PANEL_ID, render: Content, locale: LOCALE_NAMESPACE })}>{t('extension')}</protocol.ActionItem>
      registration = ctx.slots.register({ name: PANEL_SLOT_NAME, id: PANEL_ACTION_ID, registrant: PLUGIN_ID, order: PANEL_ACTION_ORDER, priority: PANEL_ACTION_PRIORITY, locale: LOCALE_NAMESPACE, inject: () => ({}) } as never, Action)
      if (retryTimer !== undefined) {
        window.clearInterval(retryTimer)
        retryTimer = undefined
      }
    }

    attemptRegistration()
    if (!registration)
      retryTimer = window.setInterval(attemptRegistration, 50)
    return () => {
      if (retryTimer !== undefined)
        window.clearInterval(retryTimer)
      registration?.()
    }
  })
}
