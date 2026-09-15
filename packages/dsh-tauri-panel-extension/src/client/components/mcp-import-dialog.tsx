import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { McpImportItem } from './mcp-tab.types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMountStyle } from 'dsh-tauri-ui/client'
import { MCP_IMPORT_DIALOG_STYLE_ID } from '../constants'
import mcpImportDialogStyle from './mcp-import-dialog.cssr'
import { importGroups } from './mcp-tab.utils'

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
  useMountStyle(mcpImportDialogStyle, MCP_IMPORT_DIALOG_STYLE_ID)
  const { t, open, items, busy, formError, onClose, onToggle, onToggleGroup, onImport } = props
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t('close')}
      title={t('importServers')}
      className="dshp-extension dshp-extension__modal-wide"
    >
      <div className="dshp-extension__form">
        <p className="dshp-extension__intro">{t('importIntro')}</p>
        {items === null && <p className="dshp-extension__empty">{t('loading')}</p>}
        {items !== null && items.length === 0 && <p className="dshp-extension__empty">{t('importEmpty')}</p>}
        {items !== null && items.length > 0 && (
          <div className="dshp-extension__import-scroll">
            {importGroups(items).map((group) => {
              const selectable = group.items
                .filter(({ item }) => !item.existing)
                .map(({ index }) => index)
              const allChecked = selectable.length > 0
                && selectable.every(index => items[index].checked)
              return (
                <section className="dshp-extension__import-group" key={group.agent}>
                  <div className="dshp-extension__import-head">
                    <span className="dshp-extension__tag" data-kind="source">{group.label}</span>
                    <span className="dshp-extension__import-count">{group.items.length}</span>
                    {selectable.length > 0 && (
                      <label className="dshp-extension__import-all">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={event => onToggleGroup(selectable, event.target.checked)}
                        />
                        {t('importSelectAll')}
                      </label>
                    )}
                  </div>
                  <ul className="dshp-extension__cards dshp-extension__cards--single">
                    {group.items.map(({ item, index }) => {
                      const command = item.server.transport === 'stdio'
                        ? `${item.server.command ?? ''} ${(item.server.args ?? []).join(' ')}`.trim()
                        : item.server.url ?? ''
                      return (
                        <li className={`dshp-extension__card${item.existing ? ' dshp-extension__card--muted' : ''}`} key={`${item.server.agent}/${item.server.name}`}>
                          <div className="dshp-extension__card-top">
                            <label className={`dshp-extension__import-choice${item.existing ? ' dshp-extension__import-choice--disabled' : ''}`}>
                              <input
                                type="checkbox"
                                checked={item.checked}
                                disabled={item.existing}
                                onChange={event => onToggle(index, event.target.checked)}
                              />
                              <strong className="dshp-extension__card-title" title={item.server.name}>{item.server.name}</strong>
                            </label>
                            <span className="dshp-extension__tag">{item.server.transport}</span>
                            {item.existing && <span className="dshp-extension__tag">{t('importExisting')}</span>}
                          </div>
                          <p className="dshp-extension__card-desc" title={command}>{command}</p>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
        {formError !== null && <p className="dshp-extension__form-error">{formError}</p>}
        <div className="dshp-extension__card-row">
          <span className="dshp-extension__spacer" />
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
