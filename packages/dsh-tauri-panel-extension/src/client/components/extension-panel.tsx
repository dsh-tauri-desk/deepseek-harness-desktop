import type { ReactElement } from 'react'
import { useMountStyle } from 'dsh-tauri-ui/client'
import { useEffect, useId, useRef, useState } from 'react'
import { EXTENSION_PANEL_STYLE_ID } from '../constants'
import { locale } from '../locales'
import extensionPanelStyle from './extension-panel.cssr'
import { McpTab } from './mcp-tab'
import { SkillsTab } from './skills-tab'

export interface ExtensionPanelProps {
  createSkill: () => Promise<void>
}

export function ExtensionPanel({ createSkill }: ExtensionPanelProps): ReactElement {
  const t = locale.text
  useMountStyle(extensionPanelStyle, EXTENSION_PANEL_STYLE_ID)
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rows = [{ id: 'skills', label: t('skillsTab') }, { id: 'mcp', label: t('mcpTab') }]
  const [activeId, setActiveId] = useState('skills')
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(['skills']))
  useEffect(() => setVisited(previous => previous.has(activeId) ? previous : new Set([...previous, activeId])), [activeId])

  return (
    <div className="dshp-extension">
      <div className="dshp-extension__section">
        <div className="dshp-extension__tabs" role="tablist" aria-label={t('extension')}>
          {rows.map((row, index) => {
            const selected = row.id === activeId
            return (
              <button
                key={row.id}
                ref={(element) => { tabRefs.current[index] = element }}
                id={`${tabsId}-tab-${row.id}`}
                type="button"
                role="tab"
                className="dshp-extension__tab"
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
          return <div key={row.id} id={`${tabsId}-panel-${row.id}`} className="dshp-extension__tab-panel" role="tabpanel" aria-labelledby={`${tabsId}-tab-${row.id}`} hidden={!selected}>{row.id === 'skills' ? <SkillsTab t={t} createSkill={createSkill} /> : <McpTab t={t} />}</div>
        })}
      </div>
    </div>
  )
}
