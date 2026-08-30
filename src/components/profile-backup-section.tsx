import type { Profile, ProfileBackup } from '../hooks/use-dsh-profiles'
import { TrashBin } from '@gravity-ui/icons'
import { Button, Card, Chip, Description, Input, Label, Switch } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'

import { store } from '@/store'
import { formatBytes } from '@/utils/format'
import { toast } from '@/utils/toast'
import {
  useProfileBackups,
  useProfileBackupSettings,
} from '../hooks/use-dsh-profile-backups'
import { Item } from './item'
import { Modal } from './modal'
import { PanelState } from './panel-state'

/** 设置草稿：开关直接用布尔，数值输入保持字符串（0 = 关闭周期备份） */
interface BackupSettingsDraft {
  on_startup: boolean
  on_change: boolean
  interval_days: string
  max_count: string
  include_credentials: boolean
  notify: boolean
}

export interface ProfileBackupSectionProps {
  /** 当前使用中的档案（备份历史与自动备份都作用于它） */
  activeProfile: Profile
}

/**
 * 档案备份区：自动备份设置 + 备份历史（还原入口）。
 *
 * - 设置：启动备份 / 配置变化备份开关、周期天数与保留份数，保存走 Toast；
 * - 历史：当前档案的 ZIP 备份列表（Profile / 时间 / 原因 / 大小 / 还原按钮）。
 *   还原当前运行档案时后端返回 `serviceStopped`，这里调用既有重启流程
 *   （`store.harness.restart()`）。
 */
export function ProfileBackupSection({ activeProfile }: ProfileBackupSectionProps) {
  const { t } = useTranslation()
  const { busyAction } = useStore(store.harness)
  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })

  const { backups, loading, error, restoreBackup, restoring, deleteBackup, deleting } = useProfileBackups(activeProfile.id)
  const { settings, loading: settingsLoading, updateSettings, saving } = useProfileBackupSettings()

  // 草稿：未编辑时为 null，界面直接反映后端设置；编辑后持有本地改动。
  // 保存成功后用后端归一化值回填（draft 非空，不再跟随外部刷新）。
  const [draft, setDraft] = useState<BackupSettingsDraft | null>(null)
  const [dirty, setDirty] = useState(false)
  const draftValue: BackupSettingsDraft | null = draft ?? (settingsLoading
    ? null
    : {
        on_startup: settings.on_startup,
        on_change: settings.on_change,
        interval_days: String(settings.interval_days),
        max_count: String(settings.max_count),
        include_credentials: settings.include_credentials,
        notify: settings.notify,
      })

  const busy = busyAction !== null

  async function commitSave() {
    if (!draftValue)
      return
    try {
      const normalized = await updateSettings({
        on_startup: draftValue.on_startup,
        on_change: draftValue.on_change,
        interval_days: Number(draftValue.interval_days) || 0,
        // 0 在这里不是合法值（后端钳制 ≥1），回退到 1 而非默认 10
        max_count: Number(draftValue.max_count) || 1,
        include_credentials: draftValue.include_credentials,
        notify: draftValue.notify,
      })
      setDraft({
        on_startup: normalized.on_startup,
        on_change: normalized.on_change,
        interval_days: String(normalized.interval_days),
        max_count: String(normalized.max_count),
        include_credentials: normalized.include_credentials,
        notify: normalized.notify,
      })
      setDirty(false)
      toast(t('profiles.backup_settings_saved'), {})
    }
    catch (err) {
      console.error('[ProfileBackupSection] save backup settings failed:', err)
      toast(t('profiles.backup_settings_failed'), { variant: 'danger' })
    }
  }

  async function restore(backup: ProfileBackup) {
    try {
      await openDialog({
        title: t('profiles.restore_confirm_title'),
        status: 'danger',
        description: (
          <p>
            {t('profiles.restore_confirm_desc', { time: new Date(backup.createdAt).toLocaleString() })}
          </p>
        ),
        confirmText: t('profiles.restore_confirm'),
      })
    }
    catch {
      return
    }
    try {
      const result = await restoreBackup(backup.id)
      toast(t('profiles.restore_toast', { name: result.profile.name }), {})
      // 还原的正是当前运行档案：后端已停止 Harness，走既有重启流程
      if (result.serviceStopped) {
        toast(t('profiles.restore_restarting'), {
          description: t('profiles.activate_restart_hint'),
          timeout: 10_000,
        })
        void store.harness.restart()
      }
    }
    catch (err) {
      console.error('[ProfileBackupSection] restore failed:', err)
      // 后端在停止 Harness 之后失败时返回 SERVICE_STOPPED: 前缀错误：
      // 还原失败不能让服务一直处于停止态，走既有重启流程恢复
      if (String(err).includes('SERVICE_STOPPED:')) {
        toast(t('profiles.restore_failed_restarting'), {
          description: t('profiles.activate_restart_hint'),
          timeout: 10_000,
        })
        void store.harness.restart()
      }
      toast(t('profiles.restore_failed'), { variant: 'danger' })
    }
  }

  async function remove(backup: ProfileBackup) {
    try {
      await openDialog({
        title: t('profiles.backup_delete_confirm_title'),
        status: 'danger',
        description: (
          <p>
            {t('profiles.backup_delete_confirm_desc', { time: new Date(backup.createdAt).toLocaleString() })}
          </p>
        ),
        confirmText: t('profiles.backup_delete_confirm'),
      })
    }
    catch {
      return
    }
    try {
      await deleteBackup(backup.id)
      // 删除成功后历史列表已刷新，UI 本身就有变化，不再弹成功 toast
    }
    catch (err) {
      console.error('[ProfileBackupSection] delete backup failed:', err)
      toast(t('profiles.backup_delete_failed'), { variant: 'danger' })
    }
  }

  return (
    <div className="space-y-3">
      {/* 自动备份设置 */}
      <Card className="rounded-md bg-panel2 py-3">
        <Card.Content className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-sm font-medium text-ink">{t('profiles.backup_settings_title')}</Label>
            <Description className="text-xs text-muted">{t('profiles.backup_settings_hint')}</Description>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink">{t('profiles.backup_on_startup')}</span>
            <Switch
              isSelected={draftValue?.on_startup ?? false}
              isDisabled={!draftValue || saving}
              onChange={(next) => {
                if (draftValue) {
                  setDraft({ ...draftValue, on_startup: next })
                  setDirty(true)
                }
              }}
              aria-label={t('profiles.backup_on_startup')}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink">{t('profiles.backup_on_change')}</span>
            <Switch
              isSelected={draftValue?.on_change ?? false}
              isDisabled={!draftValue || saving}
              onChange={(next) => {
                if (draftValue) {
                  setDraft({ ...draftValue, on_change: next })
                  setDirty(true)
                }
              }}
              aria-label={t('profiles.backup_on_change')}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink">{t('profiles.backup_interval')}</span>
            <Input
              variant="secondary"
              className="h-8 w-24 rounded-md"
              type="number"
              min={0}
              value={draftValue?.interval_days ?? ''}
              disabled={!draftValue || saving}
              onChange={(e) => {
                if (draftValue) {
                  setDraft({ ...draftValue, interval_days: e.target.value })
                  setDirty(true)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  void commitSave()
              }}
              aria-label={t('profiles.backup_interval')}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink">{t('profiles.backup_max_count')}</span>
            <Input
              variant="secondary"
              className="h-8 w-24 rounded-md"
              type="number"
              min={1}
              value={draftValue?.max_count ?? ''}
              disabled={!draftValue || saving}
              onChange={(e) => {
                if (draftValue) {
                  setDraft({ ...draftValue, max_count: e.target.value })
                  setDirty(true)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  void commitSave()
              }}
              aria-label={t('profiles.backup_max_count')}
            />
          </div>

          {/* 手动备份是否包含凭据：自动备份永远不带，这里只影响「立即备份」 */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-ink">{t('profiles.backup_include_credentials')}</span>
              <Switch
                isSelected={draftValue?.include_credentials ?? false}
                isDisabled={!draftValue || saving}
                onChange={(next) => {
                  if (draftValue) {
                    setDraft({ ...draftValue, include_credentials: next })
                    setDirty(true)
                  }
                }}
                aria-label={t('profiles.backup_include_credentials')}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            </div>
            <If cond={draftValue?.include_credentials}>
              <Description className="text-[10px] text-danger">
                {t('profiles.backup_credentials_warning')}
              </Description>
            </If>
          </div>

          {/* 自动备份通知：默认关闭——后台例行行为不打扰，面向需要知晓的高级用户 */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink">{t('profiles.backup_notify')}</span>
            <Switch
              isSelected={draftValue?.notify ?? false}
              isDisabled={!draftValue || saving}
              onChange={(next) => {
                if (draftValue) {
                  setDraft({ ...draftValue, notify: next })
                  setDirty(true)
                }
              }}
              aria-label={t('profiles.backup_notify')}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>

          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              className="h-8 rounded-md"
              isDisabled={!dirty || saving}
              onPress={commitSave}
            >
              {t('buttons.save')}
            </Button>
          </div>
        </Card.Content>
      </Card>

      {/* 备份历史 */}
      <div className="flex flex-col gap-1">
        <Label className="text-sm font-medium text-ink">
          {t('profiles.backup_history_title', { name: activeProfile.name })}
        </Label>
        <Description className="text-xs text-muted">{t('profiles.backup_history_hint')}</Description>
      </div>
      <PanelState loading={loading} error={error}>
        <div className="flex flex-col gap-2">
          <If
            cond={backups.length > 0}
            else={(
              <Description className="px-1 text-xs text-muted">
                {t('profiles.backup_history_empty')}
              </Description>
            )}
          >
            {backups.map(backup => (
              <Item
                key={backup.id}
                left={(
                  <>
                    <Chip className="rounded-md" variant="primary" size="sm">
                      {t(`profiles.backup_reason_${backup.reason}`)}
                    </Chip>
                    <Description className="min-w-0 text-xs text-muted">
                      {new Date(backup.createdAt).toLocaleString()}
                    </Description>
                  </>
                )}
                right={(
                  <>
                    <Description className="shrink-0 text-xs text-muted">
                      {formatBytes(backup.sizeBytes)}
                    </Description>
                    <Button
                      size="sm"
                      variant="tertiary"
                      className="h-7 rounded-md"
                      isDisabled={busy || restoring}
                      onPress={() => restore(backup)}
                    >
                      {t('profiles.restore')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      className="h-7 w-7 rounded-md"
                      isDisabled={busy || deleting}
                      aria-label={t('profiles.backup_delete', { time: new Date(backup.createdAt).toLocaleString() })}
                      onPress={() => remove(backup)}
                    >
                      <TrashBin className="size-3.5 text-danger" />
                    </Button>
                  </>
                )}
              />
            ))}
          </If>
        </div>
      </PanelState>
      {dialogHolder}
    </div>
  )
}
