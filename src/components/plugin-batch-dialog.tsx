import type { PropsWithOverlays } from '@overlastic/react'
import type { DshPlugin } from '../hooks/use-dsh-plugins'
import { AlertDialog, Button, Chip, Spinner } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'

export type PluginBatchAction = 'disable' | 'enable' | 'remove' | 'update'

type BatchItemState = 'pending' | 'running' | 'success' | 'failed'

interface BatchItem {
  id: string
  name: string
  state: BatchItemState
  error?: string
}

export interface PluginBatchDialogProps extends PropsWithOverlays {
  action: PluginBatchAction
  plugins: DshPlugin[]
  runAction: (plugin: DshPlugin) => Promise<void>
  completeBatch: (restartNow: boolean) => Promise<void>
}

function updateBatchItem(
  items: BatchItem[],
  id: string,
  state: BatchItemState,
  error?: string,
): BatchItem[] {
  return items.map((item) => {
    if (item.id !== id)
      return item
    return { ...item, state, error }
  })
}

export function PluginBatchDialog(props: PluginBatchDialogProps) {
  const disclosure = useDisclosure({ props })
  const { t } = useTranslation()
  const [items, setItems] = useState<BatchItem[]>(() => props.plugins.map(plugin => ({
    id: plugin.id,
    name: plugin.name,
    state: 'pending',
  })))
  const [finished, setFinished] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const completionStartedRef = useRef(false)
  const [restartRequested, setRestartRequested] = useState(false)
  const [finalError, setFinalError] = useState<string | null>(null)

  useEffect(() => {
    if (!disclosure.visible)
      return
    let cancelled = false

    async function run() {
      for (const plugin of props.plugins) {
        if (cancelled)
          return
        setItems(previous => updateBatchItem(previous, plugin.id, 'running'))
        try {
          await props.runAction(plugin)
          setItems(previous => updateBatchItem(previous, plugin.id, 'success'))
        }
        catch (error) {
          setItems(previous => updateBatchItem(previous, plugin.id, 'failed', String(error)))
        }
      }

      if (cancelled)
        return
      setFinished(true)
    }

    void run()
    return () => {
      cancelled = true
    }
    // 批量弹窗每次打开只执行一次，操作回调由打开方固定传入。
    // eslint-disable-next-line react/exhaustive-deps
  }, [disclosure.visible])

  async function finishBatch(restartNow: boolean) {
    if (!finished || finalizing || completionStartedRef.current)
      return
    completionStartedRef.current = true
    setFinalError(null)
    setRestartRequested(restartNow)
    setFinalizing(true)
    try {
      await props.completeBatch(restartNow)
      disclosure.cancel()
    }
    catch (error) {
      completionStartedRef.current = false
      setFinalError(String(error))
      setFinalizing(false)
      setRestartRequested(false)
    }
  }

  function handleOpenChange(isOpen: boolean) {
    if (isOpen || !finished || finalizing || completionStartedRef.current)
      return
    void finishBatch(false)
  }

  const actionLabels: Record<PluginBatchAction, string> = {
    disable: t('plugins.disable'),
    enable: t('plugins.enable'),
    remove: t('plugins.uninstall'),
    update: t('plugins.upgrade'),
  }
  const actionLabel = actionLabels[props.action]
  let heading = t('plugins.batch_processing', { action: actionLabel })
  if (finished)
    heading = t('plugins.batch_finished')

  const succeededCount = items.filter(item => item.state === 'success').length
  const failedCount = items.filter(item => item.state === 'failed').length
  let status: 'default' | 'warning' | 'danger' = 'default'
  if (failedCount > 0)
    status = 'warning'
  if (finalError != null)
    status = 'danger'
  const showSummary = finished && !finalizing

  return (
    <AlertDialog onOpenChange={handleOpenChange} isOpen={disclosure.visible}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[480px]">
            <AlertDialog.Header>
              <AlertDialog.Icon status={status} />
              <AlertDialog.Heading>{heading}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>{t('plugins.batch_selected', { count: props.plugins.length })}</span>
                  <span>{t('plugins.batch_result_count', { succeeded: succeededCount, failed: failedCount })}</span>
                </div>
                <div className="flex max-h-[280px] flex-col gap-1.5 overflow-y-auto rounded-md bg-panel2 p-2">
                  {items.map(item => (
                    <div key={item.id} className="flex flex-col gap-1 rounded-md px-2 py-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-ink">{item.name}</span>
                        <If cond={item.state === 'pending'}>
                          <Chip size="sm" variant="soft" color="default">{t('plugins.batch_pending')}</Chip>
                        </If>
                        <If cond={item.state === 'running'}>
                          <span className="flex shrink-0 items-center gap-1 text-muted">
                            <Spinner size="sm" color="current" />
                            {t('plugins.batch_running')}
                          </span>
                        </If>
                        <If cond={item.state === 'success'}>
                          <Chip size="sm" variant="soft" color="success">{t('plugins.batch_success')}</Chip>
                        </If>
                        <If cond={item.state === 'failed'}>
                          <Chip size="sm" variant="soft" color="danger">{t('plugins.batch_failed')}</Chip>
                        </If>
                      </div>
                      <If cond={item.error != null}>
                        <p className="break-all font-mono text-[10px] leading-[1.5] text-danger">{item.error}</p>
                      </If>
                    </div>
                  ))}
                </div>
                <If cond={finalizing}>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Spinner size="sm" color="current" />
                    <If
                      cond={restartRequested}
                      then={<span>{t('plugins.batch_restarting')}</span>}
                      else={<span>{t('plugins.batch_finishing')}</span>}
                    />
                  </div>
                </If>
                <If cond={finalError != null}>
                  <p className="break-all text-xs text-danger">
                    {t('plugins.batch_restart_failed', { error: finalError })}
                  </p>
                </If>
              </div>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <If cond={showSummary}>
                <>
                  <Button
                    className="rounded-md"
                    variant="tertiary"
                    onPress={() => void finishBatch(false)}
                  >
                    {t('plugins.batch_close_later')}
                  </Button>
                  <Button
                    className="rounded-md"
                    variant="primary"
                    onPress={() => void finishBatch(true)}
                  >
                    {t('plugins.batch_restart_now')}
                  </Button>
                </>
              </If>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
