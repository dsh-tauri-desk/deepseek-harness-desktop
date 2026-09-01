/**
 * components/mcp-editor-form.tsx — MCP 服务器编辑器（json 粘贴 / 表单双 tab）。
 *
 * 纯受控表单：状态由父组件（McpTab）持有，这里只渲染与回调。
 */

import type { ReactElement } from 'react'
import type { McpEditorMode, McpEditorState, Translate } from '../types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

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
  const { t, editor, mode, busy, pasteJson, pasteError, formError, onModeChange, onEditorChange, onPasteJsonChange, onPasteFill, onCancel, onSave } = props
  return (
    <div className="dpte-form">
      <div className="dpte-editorTabs" role="tablist" aria-label={t('addServer')}>
        {(['json', 'form'] as const).map(modeKey => (
          <button
            key={modeKey}
            type="button"
            role="tab"
            className="dpte-editorTab"
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
            <div className="dpte-form" role="tabpanel">
              <label className="dpte-label">
                <span>{t('formatPaste')}</span>
                <textarea
                  className="dpte-textarea dpte-jsonEditor"
                  placeholder={'{\n  "mcpServers": {\n    "name": { "command": "npx", "args": ["-y", "@example/mcp-server"] }\n  }\n}\n'}
                  value={pasteJson}
                  onChange={event => onPasteJsonChange(event.target.value)}
                />
              </label>
              {pasteError !== null && <p className="dpte-formError">{pasteError}</p>}
              <div className="dpte-cardRow">
                <Button variant="outline" size="sm" disabled={pasteJson.trim() === ''} onClick={onPasteFill}>{t('formatFill')}</Button>
              </div>
            </div>
          )
        : (
            <div className="dpte-form" role="tabpanel">
              <label className="dpte-label">
                <span>{t('serverName')}</span>
                <input
                  className="dpte-input"
                  value={editor.serverName}
                  disabled={editor.id !== ''}
                  onChange={event => onEditorChange({ serverName: event.target.value })}
                />
              </label>
              <label className="dpte-label">
                <span>{t('transport')}</span>
                <select
                  className="dpte-select"
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
                      <label className="dpte-label">
                        <span>{t('command')}</span>
                        <input className="dpte-input" value={editor.command} onChange={event => onEditorChange({ command: event.target.value })} />
                      </label>
                      <label className="dpte-label">
                        <span>{t('args')}</span>
                        <textarea className="dpte-textarea" data-short="true" value={editor.args} onChange={event => onEditorChange({ args: event.target.value })} />
                      </label>
                      <label className="dpte-label">
                        <span>{t('envPairs')}</span>
                        <textarea className="dpte-textarea" data-short="true" value={editor.env} onChange={event => onEditorChange({ env: event.target.value })} />
                      </label>
                    </>
                  )
                : (
                    <>
                      <label className="dpte-label">
                        <span>{t('url')}</span>
                        <input className="dpte-input" value={editor.url} onChange={event => onEditorChange({ url: event.target.value })} />
                      </label>
                      <label className="dpte-label">
                        <span>{t('headersPairs')}</span>
                        <textarea className="dpte-textarea" data-short="true" value={editor.headers} onChange={event => onEditorChange({ headers: event.target.value })} />
                      </label>
                    </>
                  )}
            </div>
          )}
      {formError !== null && <p className="dpte-formError">{formError}</p>}
      <div className="dpte-cardRow">
        <span className="dpte-spacer" />
        <Button variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={onSave}>{t('save')}</Button>
      </div>
    </div>
  )
}
