import type { UnlistenFn } from '@tauri-apps/api/event'
import type { DshPlugin } from '../hooks/use-dsh-plugins'
import type { PluginCommandLogPayload } from '../store/modules/harness'
import { Copy } from '@gravity-ui/icons'
import { Button, Card, Modal, Spinner, useOverlayState } from '@heroui/react'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { useDshPlugins } from '../hooks/use-dsh-plugins'
import { harness } from '../store/modules/harness'
import { toast } from '../utils/toast'

function RecoveryLogPanel({ logs }: { logs: readonly string[] }) {
  const { t } = useTranslation()
  const text = logs.join('\n')

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(text)
      toast(t('messages.log_copied'), {})
    }
    catch (err) {
      console.error('[Harness] copy plugin recovery logs failed:', err)
    }
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-line bg-log-bg">
      <div className="flex items-center justify-between border-b border-line/40 bg-panel2/60 px-3 py-1.5">
        <span className="text-[11px] font-medium text-muted">{t('plugin_conflict.console')}</span>
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          className="size-6 min-w-6 rounded-md"
          aria-label={t('buttons.copy')}
          onPress={() => void copyLogs()}
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
      <div
        className="max-h-[min(180px,24dvh)] min-h-[80px] overflow-y-auto px-3 py-2 text-left font-mono text-[11px] leading-[1.7]"
        aria-label={t('plugin_conflict.console')}
      >
        <If cond={logs.length > 0} else={<p className="m-0 text-load-muted">{t('plugin_conflict.waiting_logs')}</p>}>
          {logs.slice(-100).map((line, index) => (
            // 日志行可能重复，以 index 区分 key
            // eslint-disable-next-line react/no-array-index-key
            <p key={`${line}-${index}`} className="m-0 flex gap-2 overflow-hidden text-ellipsis whitespace-nowrap text-log-ink">
              <span className="shrink-0 select-none text-accent">›</span>
              <span className="min-w-0 overflow-hidden text-ellipsis">{line}</span>
            </p>
          ))}
        </If>
      </div>
    </div>
  )
}

function PluginConflictRow({ plugin, disabled, onRemove }: {
  plugin: DshPlugin
  disabled: boolean
  onRemove: (plugin: DshPlugin) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/40 px-4 py-3 last:border-b-0">
      <div className="min-w-0 text-left">
        <p className="m-0 truncate text-sm font-medium text-ink">{plugin.name}</p>
        <div className="flex min-w-0 flex-wrap gap-x-2 text-[11px] leading-4 text-muted">
          <span className="truncate">{plugin.id}</span>
          <If cond={plugin.version !== ''}>
            <span>{plugin.version}</span>
          </If>
        </div>
      </div>
      <Button
        size="sm"
        variant="tertiary"
        className="shrink-0 rounded-md"
        isDisabled={disabled}
        onPress={() => onRemove(plugin)}
      >
        {t('plugin_conflict.remove')}
      </Button>
    </div>
  )
}

export default function PluginConflictRecovery() {
  const { t } = useTranslation()
  const { plugins, loading, error, refresh } = useDshPlugins()
  const { busyAction } = useStore(harness)
  const [pendingPlugin, setPendingPlugin] = useState<DshPlugin | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removalLogs, setRemovalLogs] = useState<string[]>([])
  const [removedPlugin, setRemovedPlugin] = useState<DshPlugin | null>(null)
  const modalState = useOverlayState({
    isOpen: pendingPlugin != null,
    onOpenChange: (open) => {
      if (!open && !removing)
        setPendingPlugin(null)
    },
  })
  const candidates = plugins.filter(plugin => plugin.bundled && plugin.removable)
  const disabled = removing || busyAction !== null
  const showRemovalLogs = removing || removalLogs.length > 0

  useEffect(() => {
    let disposed = false
    let unlisten: UnlistenFn | null = null

    listen<PluginCommandLogPayload>('dsh-plugin-command-log', (event) => {
      if (disposed)
        return
      setRemovalLogs(previous => [...previous, event.payload.line].slice(-200))
    }).then((stop) => {
      if (disposed)
        stop()
      else
        unlisten = stop
    }).catch((err) => {
      console.error('[PluginConflictRecovery] failed to listen plugin command logs:', err)
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  function choosePlugin(plugin: DshPlugin) {
    if (!disabled) {
      setRemovedPlugin(null)
      setPendingPlugin(plugin)
    }
  }

  function cancelRemoval() {
    if (!removing)
      setPendingPlugin(null)
  }

  async function confirmRemoval() {
    const plugin = pendingPlugin
    if (!plugin || removing)
      return
    setRemoving(true)
    setRemovedPlugin(null)
    setRemovalLogs([])
    try {
      const removed = await harness.recoverPluginConflict(plugin.id)
      if (removed) {
        setRemovedPlugin(plugin)
        await refresh()
      }
    }
    finally {
      setRemoving(false)
      setPendingPlugin(null)
    }
  }

  return (
    <>
      <Card className="max-h-[calc(100dvh_-_1rem)] w-full overflow-y-auto rounded-lg p-0 text-left">
        <div className="flex min-h-0 flex-col gap-3 p-3 sm:p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="m-0 text-sm font-semibold text-ink">{t('plugin_conflict.title')}</h2>
              <p className="m-0 mt-1 text-xs leading-5 text-load-muted">{t('plugin_conflict.description')}</p>
            </div>
            <span className="shrink-0 rounded-full border border-danger/30 bg-danger/10 px-2 py-1 text-[10px] font-medium text-danger">
              {t('status.error')}
            </span>
          </div>

          <If
            cond={loading}
            else={(
              <If
                cond={error !== ''}
                else={(
                  <If
                    cond={candidates.length > 0}
                    else={<p className="m-0 text-xs leading-5 text-load-muted">{t('plugin_conflict.empty')}</p>}
                  >
                    <div className="min-h-0 max-h-[min(300px,40dvh)] overflow-y-auto overscroll-contain rounded-md border border-line/60">
                      <div className="flex items-center justify-between border-b border-line/40 bg-panel2/50 px-3 py-2 sm:px-4">
                        <p className="m-0 text-xs font-medium text-muted">{t('plugin_conflict.loaded_plugins')}</p>
                        <span className="rounded-full bg-panel2 px-2 py-0.5 text-[11px] tabular-nums text-muted">{candidates.length}</span>
                      </div>
                      {candidates.map(plugin => (
                        <PluginConflictRow
                          key={plugin.id}
                          plugin={plugin}
                          disabled={disabled}
                          onRemove={choosePlugin}
                        />
                      ))}
                    </div>
                  </If>
                )}
              >
                <div className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5">
                  <p className="m-0 text-xs font-medium text-danger">{t('plugin_conflict.load_failed')}</p>
                  <p className="m-0 max-h-[min(96px,16dvh)] overflow-y-auto break-all font-mono text-[11px] leading-4 text-load-muted">{error}</p>
                  <Button
                    size="sm"
                    variant="tertiary"
                    className="self-end rounded-md"
                    isDisabled={disabled}
                    onPress={() => void refresh()}
                  >
                    {t('plugin_conflict.refresh')}
                  </Button>
                </div>
              </If>
            )}
          >
            <div className="flex items-center justify-center gap-2 py-2 text-xs text-load-muted">
              <Spinner size="sm" color="current" />
              <span>{t('plugin_conflict.loading')}</span>
            </div>
          </If>

          <If cond={showRemovalLogs}>
            <RecoveryLogPanel logs={removalLogs} />
          </If>

          <If cond={removedPlugin != null}>
            <div className="flex flex-col gap-3 rounded-md border border-success/30 bg-success/5 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="m-0 text-xs font-medium text-success">
                  {t('plugin_conflict.removed', { name: removedPlugin?.name })}
                </p>
                <p className="m-0 mt-1 text-xs leading-5 text-load-muted">{t('plugin_conflict.manual_restart')}</p>
              </div>
              <Button
                size="sm"
                variant="primary"
                className="w-full rounded-md sm:w-auto"
                isDisabled={busyAction !== null}
                onPress={() => void harness.restart()}
              >
                <If cond={busyAction === 'restart'} else={t('plugin_conflict.restart')}>
                  <span className="inline-flex items-center gap-2">
                    <Spinner size="sm" color="current" />
                    {t('plugin_conflict.restarting')}
                  </span>
                </If>
              </Button>
            </div>
          </If>
        </div>
      </Card>

      <Modal state={modalState}>
        <Modal.Backdrop isDismissable={!removing}>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{t('plugin_conflict.confirm_title')}</Modal.Heading>
                <Modal.CloseTrigger isDisabled={removing} />
              </Modal.Header>
              <Modal.Body className="max-h-[calc(100dvh_-_10rem)] space-y-3 overflow-y-auto">
                <p className="m-0 text-sm leading-5 text-muted">{t('plugin_conflict.confirm_message')}</p>
                <If cond={pendingPlugin != null}>
                  <div className="rounded-md bg-panel2 px-3 py-2 text-left">
                    <p className="m-0 truncate text-sm font-medium text-ink">{pendingPlugin?.name}</p>
                    <p className="m-0 break-all font-mono text-[11px] leading-4 text-muted">{pendingPlugin?.id}</p>
                  </div>
                </If>
                <If cond={showRemovalLogs}>
                  <RecoveryLogPanel logs={removalLogs} />
                </If>
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="tertiary"
                  className="rounded-md"
                  isDisabled={removing}
                  onPress={cancelRemoval}
                >
                  {t('plugin_conflict.cancel')}
                </Button>
                <Button
                  variant="primary"
                  className="rounded-md"
                  isDisabled={removing || pendingPlugin == null}
                  onPress={() => void confirmRemoval()}
                >
                  <If cond={removing} else={t('plugin_conflict.confirm')}>
                    <span className="inline-flex items-center gap-2">
                      <Spinner size="sm" color="current" />
                      {t('plugin_conflict.removing')}
                    </span>
                  </If>
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  )
}
