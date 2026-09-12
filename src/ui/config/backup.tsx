import { ArrowLeft, Delete } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Description, Label, Spinner } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { promiseTimeout, useToggle } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { Item } from '@/components/item'
import { Modal } from '@/components/modal'
import { Panel } from '@/components/panel'
import { useBackups } from '@/hooks/use-backup'
import { store } from '@/store'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'

export interface ConfigBackupProps {
  onBack: () => void
}

/** 把字节转为 MB 展示（保留 1 位小数）。 */
function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}`
}

/**
 * 轮询 health check 确认 DSH 服务已真正停止，避免文件锁冲突。
 *  - 使用剩余 timeout 约束 in-flight 的 probe（reause `promiseTimeout`），防止无限挂起
 *  - 仅当 health check 明确失败（非 transient 错误）时才视为已停止
 *  - 超时后继续执行（shutdown 可能仍在进行中）
 */
async function waitForHarnessStopped(timeoutMs = 10_000, intervalMs = 500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - start)
    if (remaining <= 0)
      break
    try {
      await Promise.race([invoke('proxy_health_check'), promiseTimeout(remaining, true, 'probe timeout')])
      // 服务仍在运行，继续等待
    }
    catch (e) {
      // probe 超时视为已停止
      if (e instanceof Error && e.message === 'probe timeout')
        return
      // 非 transient 错误视为已停止；transient 错误（502 等）继续重试
      if (!(e instanceof Error) || !/502|ECONNREFUSED|ETIMEDOUT/i.test(e.message))
        return
    }
    await promiseTimeout(intervalMs)
  }
}

export function ConfigBackup({ onBack }: ConfigBackupProps) {
  const { t } = useTranslation()
  const { backups, loading, error, createBackup, restoreBackup, deleteBackup, busy, creating, restoring, deleting } = useBackups()
  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })

  const [includeCredentials, toggleIncludeCredentials] = useToggle()

  async function handleCreate() {
    try {
      await createBackup(includeCredentials)
      toast(t('backup.created_toast'), { variant: 'accent', timeout: 5000 })
    }
    catch (err) {
      console.error('[ConfigBackup] create failed:', err)
      toast(`${t('backup.failed_toast')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  async function handleRestore(timestamp: string) {
    try {
      await openDialog({
        status: 'danger',
        title: t('backup.restore_confirm_title'),
        description: (
          <p>
            {t('backup.restore_confirm_desc', { timestamp })}
          </p>
        ),
      })
    }
    catch (e) {
      silence(e, 'backup: dialog cancelled')
      return
    }
    // 先停止 DSH 服务（释放 profile 目录的文件锁）
    toast(t('backup.restored_stopped_toast'), { variant: 'accent' })
    try {
      await invoke('shutdown_harness')
    }
    catch (e) {
      console.warn('[ConfigBackup] shutdown_harness failed (may already be stopped):', e)
    }
    // 无论 shutdown 成功与否，都验证服务已真正停止
    await waitForHarnessStopped()
    try {
      await restoreBackup(timestamp, false)
      // 还原后自动启动 DSH 服务（后台异步，不阻塞 UI）
      invoke('launch_harness').catch((e) => {
        console.warn('[ConfigBackup] launch_harness failed:', e)
      })
      const key = toast(t('backup.restored_toast'), {
        variant: 'accent',
        timeout: 10_000,
        actionProps: {
          children: t('app.restart'),
          onPress: () => {
            store.harness.restart()
            toast.close(key)
          },
        },
      })
    }
    catch (err) {
      console.error('[ConfigBackup] restore failed:', err)
      toast(`${t('backup.restore_failed')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  async function handleRestoreAsNew(timestamp: string) {
    try {
      await openDialog({
        status: 'warning',
        title: t('backup.restore_new_confirm_title'),
        description: (
          <p>
            {t('backup.restore_new_confirm_desc', { timestamp })}
          </p>
        ),
      })
    }
    catch (e) {
      silence(e, 'backup: dialog cancelled')
      return
    }
    try {
      await restoreBackup(timestamp, true)
      toast(t('backup.restored_toast'), { variant: 'accent', timeout: 5000 })
    }
    catch (err) {
      console.error('[ConfigBackup] restore as new failed:', err)
      toast(`${t('backup.restore_failed')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  async function handleDelete(timestamp: string) {
    try {
      await openDialog({
        status: 'danger',
        title: t('backup.delete_confirm_title'),
        description: (
          <p>
            {t('backup.delete_confirm_desc', { timestamp })}
          </p>
        ),
        confirmText: t('backup.delete'),
      })
    }
    catch (e) {
      silence(e, 'backup: dialog cancelled')
      return
    }
    try {
      await deleteBackup(timestamp)
      toast(t('backup.deleted_toast'), { variant: 'accent', timeout: 5000 })
    }
    catch (err) {
      console.error('[ConfigBackup] delete failed:', err)
      toast(t('backup.delete_failed'), { variant: 'danger' })
    }
  }

  return (
    <div className="space-y-3 pl-4">
      <Button variant="tertiary" className="h-8 rounded-md" onPress={onBack}>
        <ArrowLeft className="size-3.5" />
        <span>{t('backup.back_to_profiles')}</span>
      </Button>

      {/* 手动备份 */}
      <Panel.Header title={t('backup.manual_section')} description="" />
      <div className="flex flex-col gap-3">
        <Button
          variant="primary"
          className="rounded-md"
          isDisabled={busy}
          onPress={handleCreate}
        >
          <If cond={creating}>
            <Spinner size="sm" color="current" />
            <span>{t('backup.in_progress')}</span>
          </If>
          <If cond={!creating}>
            <span>{t('backup.now')}</span>
          </If>
        </Button>
        <label className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            isSelected={includeCredentials}
            onChange={(value: boolean) => toggleIncludeCredentials(value)}
            aria-label={t('backup.include_credentials')}
            className="shrink-0"
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
            </Checkbox.Content>
          </Checkbox>
          <span className="text-xs text-ink">{t('backup.include_credentials')}</span>
        </label>
        <If cond={includeCredentials}>
          <Description className="text-[10px] text-danger">
            {t('backup.credentials_warning')}
          </Description>
        </If>
      </div>

      {/* 备份列表 */}
      <Panel.Header title={t('backup.list_section')} description="" />
      <Panel.Loadable loading={loading} error={error}>
        <If
          cond={backups.length === 0}
          else={(
            <div className="flex flex-col gap-4">
              {backups.map(backup => (
                <Item
                  key={backup.timestamp}
                  left={(
                    <>
                      <Label className="text-xs font-mono text-muted">
                        {backup.timestamp}
                      </Label>
                      <Description className="text-xs font-mono text-muted">
                        {formatSize(backup.size)}
                        {' '}
                        {t('backup.size_unit')}
                      </Description>
                    </>
                  )}
                  right={(
                    <>
                      <Button
                        size="sm"
                        variant="tertiary"
                        className="h-7 rounded-md"
                        isDisabled={busy}
                        onPress={() => handleRestore(backup.timestamp)}
                      >
                        <If cond={restoring}>
                          <Spinner size="sm" color="current" />
                        </If>
                        {restoring ? t('backup.restoring') : t('backup.restore')}
                      </Button>
                      <Button
                        size="sm"
                        variant="tertiary"
                        className="h-7 rounded-md"
                        isDisabled={busy}
                        onPress={() => handleRestoreAsNew(backup.timestamp)}
                      >
                        {restoring ? t('backup.restoring') : t('backup.restore_as_new')}
                      </Button>
                      <Chip
                        className={`rounded-md${deleting ? ' cursor-not-allowed opacity-50' : ' cursor-pointer'}`}
                        variant="primary"
                        color="danger"
                        size="sm"
                        onClick={() => {
                          if (!busy)
                            handleDelete(backup.timestamp)
                        }}
                      >
                        <Delete className="size-3" />
                      </Chip>
                    </>
                  )}
                />
              ))}
            </div>
          )}
        >
          <div className="space-y-1 rounded-md border border-line bg-panel2/40 p-3">
            <Label className="text-xs font-medium text-ink">{t('backup.empty_title')}</Label>
            <Description className="text-xs text-muted">{t('backup.empty_desc')}</Description>
          </div>
        </If>
      </Panel.Loadable>

      {dialogHolder}
    </div>
  )
}
