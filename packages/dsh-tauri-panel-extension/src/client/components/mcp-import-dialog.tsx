/**
 * components/mcp-import-dialog.tsx — MCP 跨目录导入弹窗（按 agent 分组勾选）。
 *
 * 纯受控组件：勾选状态由父组件（McpTab）持有，这里只渲染与回调。
 */

import type { ReactElement } from 'react'
import type { McpImportItem, Translate } from '../types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { importGroups } from '../utils/mcp'

export interface McpImportDialogProps {
  t: Translate
  open: boolean
  items: McpImportItem[] | null
  busy: boolean
  formError: string | null
  onClose: () => void
  onToggle: (index: number, checked: boolean) => void
  onToggleGroup: (indices: number[], checked: boolean) => void
  onImport: () => void
}

export function McpImportDialog(props: McpImportDialogProps): ReactElement {
  const { t, open, items, busy, formError, onClose, onToggle, onToggleGroup, onImport } = props
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('importServers')}
      className="dpte-modalWide"
    >
      <div className="dpte-form">
        <p className="dpte-intro">{t('importIntro')}</p>
        {items === null && <p className="dpte-empty">{t('loading')}</p>}
        {items !== null && items.length === 0 && <p className="dpte-empty">{t('importEmpty')}</p>}
        {items !== null && items.length > 0 && (
          <div className="dpte-importScroll">
            {importGroups(items).map((group) => {
              const selectable = group.items
                .filter(({ item }) => !item.existing)
                .map(({ index }) => index)
              const allChecked = selectable.length > 0
                && selectable.every(index => items[index].checked)
              return (
                <section className="dpte-importGroup" key={group.agent}>
                  <div className="dpte-importHead">
                    <span className="dpte-tag" data-kind="source">{group.label}</span>
                    <span className="dpte-importCount">{group.items.length}</span>
                    {selectable.length > 0 && (
                      <label className="dpte-importAll">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={event => onToggleGroup(selectable, event.target.checked)}
                        />
                        {t('importSelectAll')}
                      </label>
                    )}
                  </div>
                  <ul className="dpte-cards dpte-cardsSingle">
                    {group.items.map(({ item, index }) => {
                      const command = item.server.transport === 'stdio'
                        ? `${item.server.command ?? ''} ${(item.server.args ?? []).join(' ')}`.trim()
                        : item.server.url ?? ''
                      return (
                        <li className={`dpte-card${item.existing ? ' dpte-cardMuted' : ''}`} key={`${item.server.agent}/${item.server.name}`}>
                          <div className="dpte-cardTop">
                            <label className={`dpte-importChoice${item.existing ? ' dpte-importChoiceDisabled' : ''}`}>
                              <input
                                type="checkbox"
                                checked={item.checked}
                                disabled={item.existing}
                                onChange={event => onToggle(index, event.target.checked)}
                              />
                              <strong className="dpte-cardTitle" title={item.server.name}>{item.server.name}</strong>
                            </label>
                            <span className="dpte-tag">{item.server.transport}</span>
                            {item.existing && <span className="dpte-tag">{t('importExisting')}</span>}
                          </div>
                          <p className="dpte-cardDesc" title={command}>{command}</p>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
        {formError !== null && <p className="dpte-formError">{formError}</p>}
        <div className="dpte-cardRow">
          <span className="dpte-spacer" />
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || items === null || !items.some(item => item.checked && !item.existing)}
            onClick={onImport}
          >
            {t('importSelected')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
