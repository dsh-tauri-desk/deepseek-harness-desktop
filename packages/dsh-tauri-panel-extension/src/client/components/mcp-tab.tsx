/**
 * components/mcp-tab.tsx — Settings → Plugins “MCP” tab：管理 profile 的
 * mcp-client 行。Mutations 改写 profile patch 并需要 dsh 重启——banner 在有
 * 桌面壳时把重启交给壳层。
 *
 * 职责拆分：纯解析/分组逻辑在 lib/mcp.ts，受控表单/导入弹窗在
 * components/mcp-editor-form.tsx 与 mcp-import-dialog.tsx，定时器管理在
 * hooks/use-timers.ts；本组件只保留列表状态与业务编排。
 */

import type { ReactElement } from 'react'
import type { McpEditorMode, McpEditorState, McpImportItem, McpRow, McpTabProps } from '../types'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import { IconMcp, IconRefresh } from '../components/icons'
import { MCP_RESTART_INITIAL_DELAY_MS, MCP_RESTART_POLL_INTERVAL_MS, MCP_RESTART_TIMEOUT_MS } from '../constants'
import { useTimers } from '../hooks/use-timers'
import { mapToPairs, parseMcpJson, parsePairs } from '../utils/mcp'
import { McpEditorForm } from './mcp-editor-form'
import { McpImportDialog } from './mcp-import-dialog'

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
  const { later } = useTimers()

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
      later(() => {
        void injected.list().then(
          () => { window.location.reload() },
          () => { poll() },
        )
      }, MCP_RESTART_POLL_INTERVAL_MS)
    }
    later(poll, MCP_RESTART_INITIAL_DELAY_MS)
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
