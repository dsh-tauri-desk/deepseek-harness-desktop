import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { McpEditorMode, McpEditorState } from './mcp-tab.types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMountStyle } from 'dsh-tauri-ui/client'
import { MCP_EDITOR_FORM_STYLE_ID } from '../constants'
import mcpEditorFormStyle from './mcp-editor-form.cssr'

export interface McpEditorFormProps {
  t: Translate
  editor: McpEditorState
  mode: McpEditorMode
  busy: boolean
  pasteJson: string
  pasteError: string | null
  formError: string | null
  onModeChange: (mode: McpEditorMode) => void
  onEditorChange: (patch: Partial<McpEditorState>) => void
  onPasteJsonChange: (value: string) => void
  onPasteFill: () => void
  onCancel: () => void
  onSave: () => void
}

export function McpEditorForm(props: McpEditorFormProps): ReactElement {
  useMountStyle(mcpEditorFormStyle, MCP_EDITOR_FORM_STYLE_ID)
  const { t, editor, mode, busy, pasteJson, pasteError, formError, onModeChange, onEditorChange, onPasteJsonChange, onPasteFill, onCancel, onSave } = props
  return (
    <div className="dshp-extension__form">
      <div className="dshp-extension__editor-tabs" role="tablist" aria-label={t('addServer')}>
        {(['json', 'form'] as const).map(modeKey => (
          <button
            key={modeKey}
            type="button"
            role="tab"
            className="dshp-extension__editor-tab"
            aria-selected={mode === modeKey}
            data-active={mode === modeKey ? 'true' : undefined}
            onClick={() => onModeChange(modeKey)}
          >
            {t(modeKey === 'json' ? 'editorJsonTab' : 'editorFormTab')}
          </button>
        ))}
      </div>
      {mode === 'json'
        ? (
            <div className="dshp-extension__form" role="tabpanel">
              <label className="dshp-extension__label">
                <span>{t('formatPaste')}</span>
                <textarea
                  className="dshp-extension__textarea dshp-extension__json-editor"
                  placeholder={'{\n  "mcpServers": {\n    "name": { "command": "npx", "args": ["-y", "@example/mcp-server"] }\n  }\n}\n'}
                  value={pasteJson}
                  onChange={event => onPasteJsonChange(event.target.value)}
                />
              </label>
              {pasteError !== null && <p className="dshp-extension__form-error">{pasteError}</p>}
              <div className="dshp-extension__card-row">
                <Button variant="outline" size="sm" disabled={pasteJson.trim() === ''} onClick={onPasteFill}>{t('formatFill')}</Button>
              </div>
            </div>
          )
        : (
            <div className="dshp-extension__form" role="tabpanel">
              <label className="dshp-extension__label">
                <span>{t('serverName')}</span>
                <input
                  className="dshp-extension__input"
                  value={editor.serverName}
                  disabled={editor.id !== ''}
                  onChange={event => onEditorChange({ serverName: event.target.value })}
                />
              </label>
              <label className="dshp-extension__label">
                <span>{t('transport')}</span>
                <select
                  className="dshp-extension__select"
                  value={editor.transport}
                  disabled={editor.id !== ''}
                  onChange={event => onEditorChange({ transport: event.target.value as McpEditorState['transport'] })}
                >
                  <option value="stdio">{t('transportStdio')}</option>
                  <option value="streamable-http">{t('transportHttp')}</option>
                </select>
              </label>
              {editor.transport === 'stdio'
                ? (
                    <>
                      <label className="dshp-extension__label">
                        <span>{t('command')}</span>
                        <input className="dshp-extension__input" value={editor.command} onChange={event => onEditorChange({ command: event.target.value })} />
                      </label>
                      <label className="dshp-extension__label">
                        <span>{t('args')}</span>
                        <textarea className="dshp-extension__textarea" data-short="true" value={editor.args} onChange={event => onEditorChange({ args: event.target.value })} />
                      </label>
                      <label className="dshp-extension__label">
                        <span>{t('envPairs')}</span>
                        <textarea className="dshp-extension__textarea" data-short="true" value={editor.env} onChange={event => onEditorChange({ env: event.target.value })} />
                      </label>
                    </>
                  )
                : (
                    <>
                      <label className="dshp-extension__label">
                        <span>{t('url')}</span>
                        <input className="dshp-extension__input" value={editor.url} onChange={event => onEditorChange({ url: event.target.value })} />
                      </label>
                      <label className="dshp-extension__label">
                        <span>{t('headersPairs')}</span>
                        <textarea className="dshp-extension__textarea" data-short="true" value={editor.headers} onChange={event => onEditorChange({ headers: event.target.value })} />
                      </label>
                    </>
                  )}
            </div>
          )}
      {formError !== null && <p className="dshp-extension__form-error">{formError}</p>}
      <div className="dshp-extension__card-row">
        <span className="dshp-extension__spacer" />
        <Button variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={onSave}>{t('save')}</Button>
      </div>
    </div>
  )
}
