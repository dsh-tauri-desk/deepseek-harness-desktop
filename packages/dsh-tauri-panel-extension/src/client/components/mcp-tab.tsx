import type { ReactElement } from 'react'
import type { McpRow } from '../apis/index.type'
import type { McpEditorMode, McpEditorState, McpImportItem, McpTabProps } from './mcp-tab.types'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ArrowRotateRight, Icon, PlugConnection, useMountStyle } from 'dsh-tauri-ui/client'
import { compact } from 'dsh-tauri/client'
import { useEffect, useState } from 'react'
import { getMcp, getMcpImportScan, postMcpCheck, postMcpImportApply, postMcpRemove, postMcpSave, postMcpToggle } from '../apis'
import { MCP_RESTART_INITIAL_DELAY_MS, MCP_RESTART_POLL_INTERVAL_MS, MCP_RESTART_TIMEOUT_MS, MCP_TAB_STYLE_ID } from '../constants'
import { useTimers } from '../hooks/use-timers'
import { restartHost } from '../service/restart'
import { isDesktopHost } from '../service/restart.utils'
import { McpEditorForm } from './mcp-editor-form'
import { McpImportDialog } from './mcp-import-dialog'
import mcpTabStyle from './mcp-tab.cssr'
import { mapToPairs, parseMcpJson, parsePairs } from './mcp-tab.utils'

export function McpTab({ t }: McpTabProps): ReactElement {
  useMountStyle(mcpTabStyle, MCP_TAB_STYLE_ID)
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
  const [scope, setScope] = useState<'all' | 'global' | 'profile'>('all')
  const [checking, setChecking] = useState<string | null>(null)
  const { later } = useTimers()

  useEffect(() => {
    let current = true
    void getMcp().then(
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
  }, [reload, t])

  const openImport = async (): Promise<void> => {
    setImportOpen(true)
    setImportItems(null)
    try {
      const body = await getMcpImportScan()
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
      const body = await postMcpImportApply({ items })
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

  const checkConnectivity = async (row: McpRow): Promise<void> => {
    setChecking(row.id)
    try {
      const result = await postMcpCheck({ id: row.id })
      setOutcome({ ok: result.ok, text: result.ok ? `${t('connectivityOk')}${result.latencyMs ? ` (${result.latencyMs}ms)` : ''}` : `${t('connectivityFailed')}: ${result.error ?? ''}` })
    }
    catch (error) {
      setOutcome({ ok: false, text: `${t('connectivityFailed')}: ${String(error)}` })
    }
    finally { setChecking(null) }
  }

  const reloadList = (showPending: boolean): void => {
    setReload(value => value + 1)
    if (showPending)
      setPending(true)
  }

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

  const doPasteFill = (): void => {
    if (editor === null || pasteJson.trim() === '')
      return
    const parsed = parseMcpJson(pasteJson)
    if ('error' in parsed) {
      setPasteError(parsed.error)
      return
    }
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
              args: compact(editor.args.split(/\r?\n/).map(line => line.trim())),
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
      await postMcpSave(input)
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
      await postMcpToggle({ id: row.id, disabled: !row.disabled })
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
      await postMcpRemove({ id: confirmId })
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
    void restartHost()
    if (isDesktopHost())
      return
    const deadline = Date.now() + MCP_RESTART_TIMEOUT_MS
    const poll = (): void => {
      if (Date.now() > deadline)
        return
      later(() => {
        void getMcp().then(
          () => { window.location.reload() },
          () => { poll() },
        )
      }, MCP_RESTART_POLL_INTERVAL_MS)
    }
    later(poll, MCP_RESTART_INITIAL_DELAY_MS)
  }

  const restartBanner = (
    <div className="dshp-extension__banner" data-kind="info" role="status">
      <StateDot state="ongoing" size={10} />
      <div className="dshp-extension__banner-body">
        <span>{restarting ? t('restarting') : t('restartNeeded')}</span>
        <span className="dshp-extension__banner-hint">
          {restarting
            ? (!isDesktopHost() && t('restartPortHint'))
            : isDesktopHost()
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
    <div className="dshp-extension__section" style={{ margin: '0' }}>
      <div className="dshp-extension__head">
        <Icon as={PlugConnection} />
        <h3>{t('mcpTitle')}</h3>
        <span className="dshp-extension__spacer" />
        <Button variant="ghost" size="sm" disabled={restarting} onClick={() => setRestartConfirm(true)}>{t('restart')}</Button>
        <Button variant="ghost" size="sm" onClick={() => void openImport()}>{t('importServers')}</Button>
        <Button variant="primary" size="sm" onClick={openCreate}>{t('addServer')}</Button>
      </div>
      <p className="dshp-extension__intro">{t('mcpIntro')}</p>

      {outcome !== null && (
        <div className="dshp-extension__banner" data-kind={outcome.ok ? 'ok' : 'error'} role="status">
          <StateDot state={outcome.ok ? 'done' : 'error'} size={10} />
          <div className="dshp-extension__banner-body"><span>{outcome.text}</span></div>
        </div>
      )}
      {(pending || restarting) && restartBanner}

      <div className="dshp-extension__list-head">
        <h3>{t('mcpTab')}</h3>
        {servers !== null && <span className="dshp-extension__count">{servers.length}</span>}
        <select className="dshp-extension__scope" aria-label={t('scope')} value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
          <option value="all">{t('scopeAll')}</option>
          <option value="global">{t('global')}</option>
          <option value="profile">{t('profile')}</option>
        </select>
        <span className="dshp-extension__spacer" />
        <button type="button" className="dshp-extension__refresh" aria-label={t('view')} title={t('view')} disabled={busy} onClick={() => setReload(value => value + 1)}>
          <Icon as={ArrowRotateRight} />
        </button>
      </div>

      {servers === null && <p className="dshp-extension__empty">{t('loading')}</p>}
      {servers !== null && servers.length === 0 && <p className="dshp-extension__empty">{t('emptyMcp')}</p>}
      {servers !== null && servers.length > 0 && (
        <ul className="dshp-extension__cards">
          {servers.filter(row => scope === 'all' || (row.layer ?? 'profile') === scope).map(row => (
            <li className="dshp-extension__card" key={row.id}>
              <div className="dshp-extension__card-top">
                <strong className="dshp-extension__card-title" title={row.id}>{row.serverName}</strong>
                <span className="dshp-extension__tag" data-kind={(row.scope ?? row.layer) === 'global' ? 'source' : undefined}>{(row.scope ?? row.layer) === 'global' ? t('scopeGlobal') : t('scopeProfile')}</span>
                <span className="dshp-extension__tag">{row.transport}</span>
                <span className="dshp-extension__tag" data-kind={row.disabled ? 'off' : undefined}>{row.disabled ? t('disabled') : t('enabled')}</span>
              </div>
              <p className="dshp-extension__card-desc">
                {row.transport === 'stdio' ? `${row.command ?? ''} ${(row.args ?? []).join(' ')}` : row.url ?? ''}
              </p>
              {row.shadowed === true && <p className="dshp-extension__form-error">{t('shadowedByGlobal')}</p>}
              {row.globalError !== undefined && <p className="dshp-extension__form-error">{row.globalError}</p>}
              <div className="dshp-extension__card-row">
                <span className="dshp-extension__spacer" />
                <Button variant="ghost" size="sm" disabled={busy || checking === row.id} onClick={() => void checkConnectivity(row)}>{checking === row.id ? t('checkRunning') : t('checkLabel')}</Button>
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
        closeLabel={t('close')}
        title={editor !== null && editor.id !== '' ? t('editServer') : t('addServer')}
        className="dshp-extension dshp-extension__modal-form"
        contentClassName="dshp-extension__modal-scroll"
      >
        {editor !== null && (
          <McpEditorForm
            t={t}
            editor={editor}
            mode={editorMode}
            busy={busy}
            pasteJson={pasteJson}
            pasteError={pasteError}
            formError={formError}
            onModeChange={setEditorMode}
            onEditorChange={patch => setEditor(current => current === null ? current : { ...current, ...patch })}
            onPasteJsonChange={setPasteJson}
            onPasteFill={doPasteFill}
            onCancel={() => setEditor(null)}
            onSave={() => void doSave()}
          />
        )}
      </Modal>

      <Modal
        open={confirmId !== null}
        onClose={() => setConfirmId(null)}
        closeLabel={t('close')}
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
        closeLabel={t('close')}
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

      <McpImportDialog
        t={t}
        open={importOpen}
        items={importItems}
        busy={busy}
        formError={formError}
        onClose={() => setImportOpen(false)}
        onToggle={(index, checked) => {
          if (importItems === null)
            return
          const next = importItems.slice()
          next[index] = { ...next[index], checked }
          setImportItems(next)
        }}
        onToggleGroup={(indices, checked) => {
          if (importItems === null)
            return
          const next = importItems.slice()
          for (const index of indices)
            next[index] = { ...next[index], checked }
          setImportItems(next)
        }}
        onImport={() => void doImport()}
      />
    </div>
  )
}
