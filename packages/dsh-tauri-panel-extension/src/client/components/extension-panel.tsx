/**
 * components/extension-panel.tsx — 扩展面板：技能 / MCP 两个 tab 的容器 UI。
 *
 * 只负责 tab 切换（键盘导航 + visited 惰性挂载）；各 tab 内容由
 * SkillsTab / McpTab 子组件承担。数据经 injected 注入（见 rpc.ts）。
 */

import type { ReactElement } from 'react'
import type { McpInjected, SkillsInjected, Translate } from '../types'
import { useEffect, useId, useRef, useState } from 'react'
import { McpTab } from './mcp-tab'
import { SkillsTab } from './skills-tab'

export interface ExtensionPanelProps {
  t: Translate
  skills: SkillsInjected
  mcp: McpInjected
  createSkill: () => Promise<void>
}

export function ExtensionPanel({ t, skills, mcp, createSkill }: ExtensionPanelProps): ReactElement {
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
