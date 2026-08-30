import type { ProfileBackup, RestoreResult } from './use-dsh-profiles'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

/** Rust 侧 config::ProfileBackupSettings 的序列化形态（snake_case） */
export interface ProfileBackupSettings {
  on_startup: boolean
  on_change: boolean
  interval_days: number
  max_count: number
  /** 手动备份是否包含 `$DSH_HOME/.credentials.yaml`（自动备份永远不带） */
  include_credentials: boolean
  /** 自动备份成功/失败是否发送原生通知（默认关闭，高级功能不打扰） */
  notify: boolean
}

export const DEFAULT_BACKUP_SETTINGS: ProfileBackupSettings = {
  on_startup: false,
  on_change: false,
  interval_days: 0,
  max_count: 10,
  include_credentials: false,
  notify: false,
}

export interface UseProfileBackupsResult {
  backups: ProfileBackup[]
  loading: boolean
  error: string
  /** 还原备份；返回后端结果（serviceStopped 时调用方需触发服务重启） */
  restoreBackup: (backupId: string) => Promise<RestoreResult>
  restoring: boolean
  /** 删除一份备份 */
  deleteBackup: (backupId: string) => Promise<void>
  deleting: boolean
}

/**
 * 指定档案的备份历史（react-query）。
 *
 * 查询键 `['profile-backups', profileId]`；后端每次成功创建 ZIP（手动 / 自动 /
 * 还原前保护备份）都会推送 `profile-backups-updated` 事件，这里按档案过滤失效重拉。
 */
export function useProfileBackups(profileId: string): UseProfileBackupsResult {
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['profile-backups', profileId],
    queryFn: () => invoke<ProfileBackup[]>('get_profile_backups', { profileId }),
    enabled: profileId.length > 0,
  })

  // 后端自动备份/还原流程创建 ZIP 后推送事件，历史列表实时刷新
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    listen<{ profileId?: string }>('profile-backups-updated', (event) => {
      // 事件载荷可能是完整备份行（camelCase）或 `{ profileId }` 简写
      const payload = event.payload as { profileId?: string }
      if (payload.profileId !== undefined && payload.profileId !== profileId)
        return
      void queryClient.invalidateQueries({ queryKey: ['profile-backups'] })
    })
      .then((fn) => {
        if (disposed)
          fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [queryClient, profileId])

  const restore = useMutation({
    mutationFn: (backupId: string) =>
      invoke<RestoreResult>('restore_profile_backup', { profileId, backupId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['profile-backups'] })
      void queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
  })
  const remove = useMutation({
    mutationFn: (backupId: string) =>
      invoke<void>('delete_profile_backup', { profileId, backupId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['profile-backups'] })
    },
  })

  return {
    backups: data ?? [],
    loading: isLoading,
    error: error ? String(error) : '',
    restoreBackup: async backupId => restore.mutateAsync(backupId),
    restoring: restore.isPending,
    deleteBackup: async backupId => remove.mutateAsync(backupId),
    deleting: remove.isPending,
  }
}

export interface UseProfileBackupSettingsResult {
  settings: ProfileBackupSettings
  loading: boolean
  /** 保存设置（后端归一化后返回，用于回填界面） */
  updateSettings: (settings: ProfileBackupSettings) => Promise<ProfileBackupSettings>
  saving: boolean
}

/**
 * 档案自动备份设置（react-query）。
 *
 * 后端把设置持久化在桌面端 store（触发 `setting_updated` 事件），
 * 这里监听事件一并失效重拉，保证与后端一致。
 */
export function useProfileBackupSettings(): UseProfileBackupSettingsResult {
  const queryClient = useQueryClient()

  const { data, isLoading, isPending } = useQuery({
    queryKey: ['profile-backup-settings'],
    queryFn: () => invoke<ProfileBackupSettings>('get_profile_backup_settings'),
  })

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    listen('setting_updated', () => {
      void queryClient.invalidateQueries({ queryKey: ['profile-backup-settings'] })
    })
      .then((fn) => {
        if (disposed)
          fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [queryClient])

  const update = useMutation({
    mutationFn: (settings: ProfileBackupSettings) =>
      invoke<ProfileBackupSettings>('update_profile_backup_settings', { settings }),
    onSuccess: (normalized) => {
      void queryClient.setQueryData(['profile-backup-settings'], normalized)
    },
  })

  return {
    settings: data ?? DEFAULT_BACKUP_SETTINGS,
    loading: isLoading,
    updateSettings: async settings => update.mutateAsync(settings),
    saving: update.isPending || isPending,
  }
}
