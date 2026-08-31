import type { ClientContext } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import type { ConversationInputLeftProps, ExtensionRuntimeContext, McpInjected, PanelProtocol, SkillsInjected, Translate } from './types'
import { compat } from 'dsh-tauri/client'
import { useEffect, useId, useRef, useState } from 'react'
import { CONVERSATION_INPUT_LEFT_SLOT, INPUT_PREFILL_ID, INPUT_PREFILL_ORDER, INPUT_PREFILL_PRIORITY, LOCALE_NAMESPACE, PANEL_ACTION_ID, PANEL_ACTION_ORDER, PANEL_ACTION_PRIORITY, PANEL_ID, PANEL_PROTOCOL_NAME, PANEL_SLOT_NAME, PLUGIN_ID, SKILL_CREATOR_DRAFT } from './constants'
import { IconExtension } from './icons'
import { McpTab } from './mcp-tab'
import { SkillsTab } from './skills-tab'
import { chooseWorkspace } from './workspace'

const pendingPrefills = new Set<string>()

function SkillCreatorPrefill({ sessionId, inputActions }: ConversationInputLeftProps): null {
  useEffect(() => {
    if (!pendingPrefills.delete(sessionId))
      return
    inputActions.setDraft(SKILL_CREATOR_DRAFT)
  }, [inputActions, sessionId])
  return null
}

export function registerSkillCreatorPrefill(ctx: ClientContext): void {
  ctx.effect(() => {
    pendingPrefills.clear()
    const disposeSlot = ctx.slots.inject(CONVERSATION_INPUT_LEFT_SLOT as never, () => ctx.slots.register({
      name: CONVERSATION_INPUT_LEFT_SLOT,
      id: INPUT_PREFILL_ID,
      registrant: PLUGIN_ID,
      order: INPUT_PREFILL_ORDER,
      priority: INPUT_PREFILL_PRIORITY,
      inject: (sessionId: string) => ({ sessionId }),
    } as never, SkillCreatorPrefill))
    return () => {
      pendingPrefills.clear()
      disposeSlot()
    }
  }, `${PLUGIN_ID}: skill creator prefill`)
}

export function ExtensionPanel({ t, skills, mcp, createSkill }: { t: Translate, skills: SkillsInjected, mcp: McpInjected, createSkill: () => Promise<void> }): ReactElement {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rows = [{ id: 'skills', label: t('skillsTab') }, { id: 'mcp', label: t('mcpTab') }]
  const [activeId, setActiveId] = useState('skills')
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(['skills']))
  useEffect(() => setVisited(previous => previous.has(activeId) ? previous : new Set([...previous, activeId])), [activeId])

  return (
    <div className="dpte-section">
      <div className="dpte-tabs" role="tablist" aria-label={t('extension')}>
        {rows.map((row, index) => {
          const selected = row.id === activeId
          return (
            <button
              key={row.id}
              ref={(element) => { tabRefs.current[index] = element }}
              id={`${tabsId}-tab-${row.id}`}
              type="button"
              role="tab"
              className="dpte-tab"
              aria-selected={selected}
              aria-controls={`${tabsId}-panel-${row.id}`}
              data-active={selected ? 'true' : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(row.id)}
              onKeyDown={(event) => {
                let next: number
                if (event.key === 'ArrowRight')
                  next = (index + 1) % rows.length
                else if (event.key === 'ArrowLeft')
                  next = (index - 1 + rows.length) % rows.length
                else if (event.key === 'Home')
                  next = 0
                else if (event.key === 'End')
                  next = rows.length - 1
                else return
                event.preventDefault()
                setActiveId(rows[next]?.id ?? 'skills')
                tabRefs.current[next]?.focus()
              }}
            >
              {row.label}
            </button>
          )
        })}
      </div>
      {rows.filter(row => row.id === activeId || visited.has(row.id)).map((row) => {
        const selected = row.id === activeId
        return <div key={row.id} id={`${tabsId}-panel-${row.id}`} className="dpte-tabPanel" role="tabpanel" aria-labelledby={`${tabsId}-tab-${row.id}`} hidden={!selected}>{row.id === 'skills' ? <SkillsTab t={t} injected={skills} createSkill={createSkill} /> : <McpTab t={t} injected={mcp} />}</div>
      })}
    </div>
  )
}

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
