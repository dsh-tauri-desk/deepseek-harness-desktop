/**
 * Settings → Plugins “MCP” tab: manage the profile's mcp-client rows.
 * Mutations rewrite the profile patch and need a dsh restart — the banner
 * hands the restart to the desktop shell when one is present.
 */

import type { ReactElement } from 'react'
import type { McpEditorMode, McpEditorState, McpImportItem, McpRow, McpTabProps, ParsedMcpJson } from './types'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { MCP_RESTART_INITIAL_DELAY_MS, MCP_RESTART_POLL_INTERVAL_MS, MCP_RESTART_TIMEOUT_MS } from './constants'
import { IconMcp, IconRefresh } from './icons'

/** Group import candidates by source agent, known agents first. */
export function importGroups(items: McpImportItem[]): Array<{ agent: string, label: string, items: Array<{ item: McpImportItem, index: number }> }> {
  const label = (agent: string): string => agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent
  const order = ['claude-code', 'codex']
  const agents = [...new Set(items.map(item => item.server.agent))]
    .sort((a, b) => {
      const rank = (agent: string): number => {
        const at = order.indexOf(agent)
        return at === -1 ? order.length : at
      }
      return rank(a) - rank(b) || a.localeCompare(b)
    })
  return agents.map(agent => ({
    agent,
    label: label(agent),
    items: items.map((item, index) => ({ item, index })).filter(({ item }) => item.server.agent === agent),
  }))
}

/** KEY=VALUE / KEY: VALUE lines to a map. */
function parsePairs(text: string, separator: ':' | '='): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#'))
      continue
    const at = trimmed.indexOf(separator)
    if (at <= 0)
      continue
    map[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return map
}

function mapToPairs(map: Record<string, string> | undefined, separator: string): string {
  if (map === undefined)
    return ''
  return Object.entries(map).map(([key, value]) => `${key}${separator}${value.includes('\n') ? JSON.stringify(value) : value}`).join('\n')
}

/**
 * Parse one MCP server from pasted JSON: a bare entry, a dsh row, or a
 *  `{"mcpServers": {…}}` wrapper (first entry wins). Returns the reason on bad input.
 */
export function parseMcpJson(text: string): ParsedMcpJson | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return { error: 'not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { error: 'expected a JSON object' }
  let record = parsed as Record<string, unknown>
  let nameFromWrapper: string | undefined
  const wrapped = record.mcpServers ?? record.mcp_servers ?? record.servers
  if (typeof wrapped === 'object' && wrapped !== null && !Array.isArray(wrapped)) {
    const first = Object.entries(wrapped as Record<string, unknown>)[0]
    if (first === undefined)
      return { error: 'mcpServers object is empty' }
    nameFromWrapper = first[0]
    if (typeof first[1] !== 'object' || first[1] === null)
      return { error: 'server entry is not an object' }
    record = first[1] as Record<string, unknown>
  }
  const stringMap = (value: unknown): Record<string, string> | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return undefined
    const out: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string')
        out[key] = entry
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  const args = Array.isArray(record.args) && record.args.every(entry => typeof entry === 'string')
    ? record.args as string[]
    : undefined
  const command = typeof record.command === 'string' ? record.command : undefined
  const url = typeof record.url === 'string' ? record.url : undefined
  const declared = typeof record.type === 'string' ? record.type : typeof record.transport === 'string' ? record.transport : undefined
  const httpDeclared = declared === 'http' || declared === 'streamable-http' || declared === 'sse'
  const transport: 'stdio' | 'streamable-http' = command !== undefined && !httpDeclared
    ? 'stdio'
    : url !== undefined ? 'streamable-http' : httpDeclared ? 'streamable-http' : 'stdio'
  if (transport === 'stdio' && command === undefined)
    return { error: 'stdio config needs a "command" field' }
  if (transport === 'streamable-http' && url === undefined)
    return { error: 'http config needs a "url" field' }
  const serverName = nameFromWrapper
    ?? (typeof record.serverName === 'string' ? record.serverName : undefined)
    ?? (typeof record.name === 'string' && record.name !== '@deepseek-ai/dsh-mcp-client' ? record.name : undefined)
  const env = stringMap(record.env)
  const headers = stringMap(record.headers)
  return {
    ...(serverName !== undefined ? { serverName } : {}),
    transport,
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(headers !== undefined ? { headers } : {}),
  }
}

export function McpTab(props: McpTabProps): ReactElement {
  const { t, injected } = props
  const [servers, setServers] = useState<McpRow[] | null>(null)
  const [editor, setEditor] = useState<McpEditorState | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importItems, setImportItems] = useState<McpImportItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(false)
  const [restartConfirm, setRestartConfirm] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean, text: string } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [editorMode, setEditorMode] = useState<McpEditorMode>('json')
  const [pasteJson, setPasteJson] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const restartTimers = useRef<Set<number>>(new Set())

  useEffect(() => () => {
    for (const timer of restartTimers.current) window.clearTimeout(timer)
    restartTimers.current.clear()
  }, [])

  const scheduleRestartPoll = (callback: () => void, delay: number): void => {
    const timer = window.setTimeout(() => {
      restartTimers.current.delete(timer)
      callback()
    }, delay)
    restartTimers.current.add(timer)
  }

  const openImport = async (): Promise<void> => {
    setImportOpen(true)
    setImportItems(null)
    try {
      const body = await injected.scanImport()
      const existing = new Set(body.existing)
      setImportItems(body.servers.map(server => ({
        server,
        existing: existing.has(server.name),
        checked: !existing.has(server.name),
      })))
    }
    catch (error) {
      setImportItems([])
      setOutcome({ ok: false, text: `${t('failed')}: ${String(error instanceof Error ? error.message : error)}` })
    }
  }

  const doImport = async (): Promise<void> => {
    if (importItems === null)
      return
    const items = importItems.filter(item => item.checked && !item.existing).map(item => ({ agent: item.server.agent, name: item.server.name }))
    setBusy(true)
    try {
      const body = await injected.applyImport(items)
      const failed = body.results.filter(item => !item.ok)
      setOutcome(failed.length === 0
        ? null
        : { ok: false, text: `${t('failed')}: ${failed.map(item => `${item.name} (${item.error})`).join(', ')}` })
      setImportOpen(false)
      setPending(true)
      setReload(value => value + 1)
    }
    catch (error) {
      setOutcome({ ok: false, text: `${t('failed')}: ${String(error instanceof Error ? error.message : error)}` })
    }
    finally {
      setBusy(false)
    }
  }

  const reloadList = (showPending: boolean): void => {
    setReload(value => value + 1)
    if (showPending)
      setPending(true)
  }

  useEffect(() => {
    let current = true
    void injected.list().then(
      (body) => {
        if (current)
          setServers(body.servers)
      },
      (error: Error) => {
        if (current) {
          setServers([])
          setOutcome({ ok: false, text: `${t('failed')}: ${String(error.message ?? error)}` })
        }
      },
    )
    return () => {
      current = false
    }
  }, [injected, reload, t])

  const openCreate = (): void => {
    setFormError(null)
    setPasteError(null)
    setPasteJson('')
    setEditorMode('json')
    setEditor({ id: '', serverName: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '' })
  }

  const openEdit = (row: McpRow): void => {
    setFormError(null)
    setPasteError(null)
    setPasteJson('')
    setEditorMode('form')
    setEditor({
      id: row.id,
      serverName: row.serverName,
      transport: row.transport,
      command: row.command ?? '',
      args: (row.args ?? []).join('\n'),
      env: mapToPairs(row.env, '='),
      url: row.url ?? '',
      headers: mapToPairs(row.headers, ':'),
    })
  }

  /** Fill the form from pasted JSON (mcpServers wrapper, bare entry, dsh row). */
  const doPasteFill = (): void => {
    if (editor === null || pasteJson.trim() === '')
      return
    const parsed = parseMcpJson(pasteJson)
    if ('error' in parsed) {
      setPasteError(parsed.error)
      return
    }
    // Existing rows keep their identity (serverName + transport); a pasted
    // config of the other transport cannot apply to them.
    const lockIdentity = editor.id !== ''
    if (lockIdentity && parsed.transport !== editor.transport) {
      setPasteError(t('pasteTransportMismatch'))
      return
    }
    setPasteError(null)
    setFormError(null)
    setEditor({
      ...editor,
      ...(parsed.serverName !== undefined && !lockIdentity ? { serverName: parsed.serverName } : {}),
      ...(!lockIdentity ? { transport: parsed.transport } : {}),
      ...(parsed.transport === 'stdio'
        ? {
            command: parsed.command ?? editor.command,
            args: (parsed.args ?? []).join('\n'),
            env: mapToPairs(parsed.env, '='),
          }
        : {
            url: parsed.url ?? editor.url,
            headers: mapToPairs(parsed.headers, ':'),
          }),
    })
    setEditorMode('form')
  }

  const doSave = async (): Promise<void> => {
    if (editor === null)
      return
    let input: Record<string, unknown>
    if (editorMode === 'json') {
      const parsed = parseMcpJson(pasteJson)
      if ('error' in parsed) {
        setPasteError(parsed.error)
        return
      }
      input = {
        id: editor.id,
        serverName: parsed.serverName?.trim() ?? '',
        transport: parsed.transport,
        ...(parsed.transport === 'stdio'
          ? { command: parsed.command ?? '', args: parsed.args ?? [], env: parsed.env ?? {} }
          : { url: parsed.url ?? '', headers: parsed.headers ?? {} }),
      }
    }
    else {
      input = {
        id: editor.id,
        serverName: editor.serverName.trim(),
        transport: editor.transport,
        ...(editor.transport === 'stdio'
          ? {
              command: editor.command.trim(),
              args: editor.args.split(/\r?\n/).map(line => line.trim()).filter(line => line !== ''),
              env: parsePairs(editor.env, '='),
            }
          : {
              url: editor.url.trim(),
              headers: parsePairs(editor.headers, ':'),
            }),
      }
    }
    setBusy(true)
    setFormError(null)
    setPasteError(null)
    try {
      await injected.save(input)
      setEditor(null)
      setOutcome(null)
      reloadList(true)
    }
    catch (error) {
      setFormError(String(error instanceof Error ? error.message : error))
    }
    finally {
      setBusy(false)
    }
  }

  const doToggle = async (row: McpRow): Promise<void> => {
    setBusy(true)
    try {
      await injected.toggle(row.id, !row.disabled)
      setOutcome(null)
      reloadList(true)
    }
    catch (error) {
      setOutcome({ ok: false, text: `${t('failed')}: ${String(error instanceof Error ? error.message : error)}` })
    }
    finally {
      setBusy(false)
    }
  }

  const doRemove = async (): Promise<void> => {
    if (confirmId === null)
      return
    setBusy(true)
    try {
      await injected.remove(confirmId)
      setOutcome(null)
      reloadList(true)
    }
    catch (error) {
      setOutcome({ ok: false, text: `${t('failed')}: ${String(error instanceof Error ? error.message : error)}` })
    }
    finally {
      setBusy(false)
      setConfirmId(null)
    }
  }

  const doRestart = (): void => {
    setRestartConfirm(false)
    setRestarting(true)
    void injected.restart()
    // 桌面模式：壳层重启完成后会重载窗口。独立模式：轮询本源，恢复即刷新。
    if (injected.desktop)
      return
    const deadline = Date.now() + MCP_RESTART_TIMEOUT_MS
    const poll = (): void => {
      if (Date.now() > deadline)
        return
      scheduleRestartPoll(() => {
        void injected.list().then(
          () => { window.location.reload() },
          () => { poll() },
        )
      }, MCP_RESTART_POLL_INTERVAL_MS)
    }
    scheduleRestartPoll(poll, MCP_RESTART_INITIAL_DELAY_MS)
  }

  const restartBanner = (
    <div className="dpte-banner" data-kind="info" role="status">
      <StateDot state="ongoing" size={10} />
      <div className="dpte-bannerBody">
        <span>{restarting ? t('restarting') : t('restartNeeded')}</span>
        <span className="dpte-bannerHint">
          {restarting
            ? (!injected.desktop && t('restartPortHint'))
            : injected.desktop
              ? (
                  <>
                    {t('restartDesktopHint')}
                    {' '}
                    <Button variant="outline" size="sm" onClick={() => setRestartConfirm(true)}>{t('restartNow')}</Button>
                  </>
                )
              : t('restartOtherHint')}
        </span>
      </div>
    </div>
  )

  return (
    <div className="dpte-section">
      <div className="dpte-head">
        <IconMcp />
        <h3>{t('mcpTitle')}</h3>
        <span className="dpte-spacer" />
        <Button variant="ghost" size="sm" disabled={restarting} onClick={() => setRestartConfirm(true)}>{t('restart')}</Button>
        <Button variant="ghost" size="sm" onClick={() => void openImport()}>{t('importServers')}</Button>
        <Button variant="primary" size="sm" onClick={openCreate}>{t('addServer')}</Button>
      </div>
      <p className="dpte-intro">{t('mcpIntro')}</p>

      {outcome !== null && (
        <div className="dpte-banner" data-kind={outcome.ok ? 'ok' : 'error'} role="status">
          <StateDot state={outcome.ok ? 'done' : 'error'} size={10} />
          <div className="dpte-bannerBody"><span>{outcome.text}</span></div>
        </div>
      )}
      {(pending || restarting) && restartBanner}

      <div className="dpte-listHead">
        <h3>{t('mcpTab')}</h3>
        {servers !== null && <span className="dpte-count">{servers.length}</span>}
        <span className="dpte-spacer" />
        <button type="button" className="dpte-refresh" aria-label={t('view')} title={t('view')} disabled={busy} onClick={() => setReload(value => value + 1)}>
          <IconRefresh />
        </button>
      </div>

      {servers === null && <p className="dpte-empty">{t('loading')}</p>}
      {servers !== null && servers.length === 0 && <p className="dpte-empty">{t('emptyMcp')}</p>}
      {servers !== null && servers.length > 0 && (
        <ul className="dpte-cards">
          {servers.map(row => (
            <li className="dpte-card" key={row.id}>
              <div className="dpte-cardTop">
                <strong className="dpte-cardTitle" title={row.id}>{row.serverName}</strong>
                <span className="dpte-tag">{row.transport}</span>
                <span className="dpte-tag" data-kind={row.disabled ? 'off' : undefined}>{row.disabled ? t('disabled') : t('enabled')}</span>
              </div>
              <p className="dpte-cardDesc">
                {row.transport === 'stdio' ? `${row.command ?? ''} ${(row.args ?? []).join(' ')}` : row.url ?? ''}
              </p>
              <div className="dpte-cardRow">
                <span className="dpte-spacer" />
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void doToggle(row)}>{t('toggle')}</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => openEdit(row)}>{t('edit')}</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmId(row.id)}>{t('delete')}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor !== null && editor.id !== '' ? t('editServer') : t('addServer')}
        className="dpte-modalForm"
        contentClassName="dpte-modalScroll"
      >
        {editor !== null && (
          <div className="dpte-form">
            <div className="dpte-editorTabs" role="tablist" aria-label={t('addServer')}>
              {(['json', 'form'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  className="dpte-editorTab"
                  aria-selected={editorMode === mode}
                  data-active={editorMode === mode ? 'true' : undefined}
                  onClick={() => setEditorMode(mode)}
                >
                  {t(mode === 'json' ? 'editorJsonTab' : 'editorFormTab')}
                </button>
              ))}
            </div>
            {editorMode === 'json'
              ? (
                  <div className="dpte-form" role="tabpanel">
                    <label className="dpte-label">
                      <span>{t('formatPaste')}</span>
                      <textarea
                        className="dpte-textarea dpte-jsonEditor"
                        placeholder={'{\n  "mcpServers": {\n    "name": { "command": "npx", "args": ["-y", "@example/mcp-server"] }\n  }\n}\n'}
                        value={pasteJson}
                        onChange={event => setPasteJson(event.target.value)}
                      />
                    </label>
                    {pasteError !== null && <p className="dpte-formError">{pasteError}</p>}
                    <div className="dpte-cardRow">
                      <Button variant="outline" size="sm" disabled={pasteJson.trim() === ''} onClick={doPasteFill}>{t('formatFill')}</Button>
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
                        onChange={event => setEditor({ ...editor, serverName: event.target.value })}
                      />
                    </label>
                    <label className="dpte-label">
                      <span>{t('transport')}</span>
                      <select
                        className="dpte-select"
                        value={editor.transport}
                        disabled={editor.id !== ''}
                        onChange={event => setEditor({ ...editor, transport: event.target.value as McpEditorState['transport'] })}
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
                              <input className="dpte-input" value={editor.command} onChange={event => setEditor({ ...editor, command: event.target.value })} />
                            </label>
                            <label className="dpte-label">
                              <span>{t('args')}</span>
                              <textarea className="dpte-textarea" data-short="true" value={editor.args} onChange={event => setEditor({ ...editor, args: event.target.value })} />
                            </label>
                            <label className="dpte-label">
                              <span>{t('envPairs')}</span>
                              <textarea className="dpte-textarea" data-short="true" value={editor.env} onChange={event => setEditor({ ...editor, env: event.target.value })} />
                            </label>
                          </>
                        )
                      : (
                          <>
                            <label className="dpte-label">
                              <span>{t('url')}</span>
                              <input className="dpte-input" value={editor.url} onChange={event => setEditor({ ...editor, url: event.target.value })} />
                            </label>
                            <label className="dpte-label">
                              <span>{t('headersPairs')}</span>
                              <textarea className="dpte-textarea" data-short="true" value={editor.headers} onChange={event => setEditor({ ...editor, headers: event.target.value })} />
                            </label>
                          </>
                        )}
                  </div>
                )}
            {formError !== null && <p className="dpte-formError">{formError}</p>}
            <div className="dpte-cardRow">
              <span className="dpte-spacer" />
              <Button variant="ghost" onClick={() => setEditor(null)}>{t('cancel')}</Button>
              <Button variant="primary" disabled={busy} onClick={() => void doSave()}>{t('save')}</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={confirmId !== null}
        onClose={() => setConfirmId(null)}
        title={t('confirmRemove')}
        description={confirmId ?? undefined}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setConfirmId(null)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void doRemove()}>{t('delete')}</Button>
          </>
        )}
      >
        <p>{t('removeWarn')}</p>
      </Modal>

      <Modal
        open={restartConfirm}
        onClose={() => setRestartConfirm(false)}
        title={t('restartConfirmTitle')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setRestartConfirm(false)}>{t('cancel')}</Button>
            <Button variant="primary" onClick={doRestart}>{t('restartNow')}</Button>
          </>
        )}
      >
        <p>{t('restartConfirmBody')}</p>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={t('importServers')}
        className="dpte-modalWide"
      >
        <div className="dpte-form">
          <p className="dpte-intro">{t('importIntro')}</p>
          {importItems === null && <p className="dpte-empty">{t('loading')}</p>}
          {importItems !== null && importItems.length === 0 && <p className="dpte-empty">{t('importEmpty')}</p>}
          {importItems !== null && importItems.length > 0 && (
            <div className="dpte-importScroll">
              {importGroups(importItems).map((group) => {
                const selectable = group.items
                  .filter(({ item }) => !item.existing)
                  .map(({ index }) => index)
                const allChecked = selectable.length > 0
                  && selectable.every(index => importItems[index].checked)
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
                            onChange={(event) => {
                              const next = importItems.slice()
                              for (const index of selectable) next[index] = { ...next[index], checked: event.target.checked }
                              setImportItems(next)
                            }}
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
                                  onChange={(event) => {
                                    const next = importItems.slice()
                                    next[index] = { ...item, checked: event.target.checked }
                                    setImportItems(next)
                                  }}
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
            <Button variant="ghost" onClick={() => setImportOpen(false)}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy || importItems === null || !importItems.some(item => item.checked && !item.existing)}
              onClick={() => void doImport()}
            >
              {t('importSelected')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
