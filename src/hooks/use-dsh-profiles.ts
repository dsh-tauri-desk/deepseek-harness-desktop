import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

/** Rust 侧 service::profile::Profile 的序列化形态（camelCase） */
export interface Profile {
  /** 档案 id（$DSH_HOME/profiles/<id> 目录名） */
  id: string
  /** 展示名（manifest name 去 dsh-profile- 前缀，首字母大写） */
  name: string
  /** 描述（manifest.description；克隆自动写入「克隆自 <源>」） */
  description: string
  /** 是否桌面端内置默认档案（web） */
  default: boolean
  /** 是否当前使用中的档案 */
  active: boolean
}

/** Rust 侧 service::profile::backup::ProfileBackup 的序列化形态（camelCase） */
export interface ProfileBackup {
  /** 备份 id（`<创建时间ms>-<原因>`，即文件名去 .zip） */
  id: string
  /** 所属档案 id */
  profileId: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 触发原因（manual / startup / interval / config_change / before_restore） */
  reason: string
  /** 压缩包字节数 */
  sizeBytes: number
}

/** Rust 侧 service::profile::backup::RestoreResult 的序列化形态（camelCase） */
export interface RestoreResult {
  profile: Profile
  /** 还原的正是当前运行档案时后端已停止 Harness，前端需调用既有重启流程 */
  serviceStopped: boolean
}

export interface UseDshProfilesResult {
  profiles: Profile[]
  loading: boolean
  error: string
  /** 新建档案（返回新档案；不自动激活） */
  createProfile: (name: string) => Promise<Profile>
  /** 克隆档案（复制配置、排除依赖目录；name 为自定义新档案名称） */
  cloneProfile: (sourceId: string, name: string) => Promise<Profile>
  /** 重命名档案（含描述；只改 manifest 展示元信息，目录 id 不变） */
  renameProfile: (id: string, name: string, description: string) => Promise<Profile>
  /** 切换当前使用中的档案（持久化；重启服务后生效） */
  activateProfile: (id: string) => Promise<Profile>
  /** 删除档案（当前使用中的档案会被后端拒绝） */
  removeProfile: (id: string) => Promise<void>
  /** 手动创建档案备份（返回创建的备份行） */
  backupNow: (id: string) => Promise<ProfileBackup>
  /** 操作进行中标记（新建/克隆/重命名/切换/删除任一） */
  busy: boolean
}

/**
 * 档案列表与操作（react-query）。
 *
 * 查询键 `['profiles']`：`set_active_profile` 会写桌面端 store（触发
 * `setting_updated` 事件），这里监听该事件一并失效重拉，保证与后端设置一致。
 */
export function useDshProfiles(): UseDshProfilesResult {
  const queryClient = useQueryClient()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => invoke<Profile[]>('get_profiles'),
  })

  // 后端设置变更（切换档案等）后刷新档案列表
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    listen('setting_updated', () => {
      void queryClient.invalidateQueries({ queryKey: ['profiles'] })
    })
      .then((fn) => {
        // 竞态防护：若组件已卸载而 listen 才 resolve，立即注销防泄漏
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

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['profiles'] })
  }

  const create = useMutation({
    mutationFn: (name: string) => invoke<Profile>('create_profile', { name }),
    onSuccess: invalidate,
  })
  const clone = useMutation({
    mutationFn: (args: { id: string, name: string }) => invoke<Profile>('clone_profile', args),
    onSuccess: invalidate,
  })
  const rename = useMutation({
    mutationFn: (args: { id: string, name: string, description: string }) =>
      invoke<Profile>('rename_profile', args),
    onSuccess: invalidate,
  })
  const activate = useMutation({
    mutationFn: (id: string) => invoke<Profile>('set_active_profile', { id }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => invoke<void>('remove_profile', { id }),
    onSuccess: invalidate,
  })
  const backup = useMutation({
    mutationFn: (id: string) => invoke<ProfileBackup>('create_profile_backup', { profileId: id }),
  })

  return {
    profiles: data ?? [],
    loading: isLoading,
    error: error ? String(error) : '',
    createProfile: async (name) => {
      const created = await create.mutateAsync(name)
      await refetch()
      return created
    },
    cloneProfile: async (sourceId, name) => {
      const cloned = await clone.mutateAsync({ id: sourceId, name })
      await refetch()
      return cloned
    },
    renameProfile: async (id, name, description) => {
      const renamed = await rename.mutateAsync({ id, name, description })
      await refetch()
      return renamed
    },
    activateProfile: async (id) => {
      const activated = await activate.mutateAsync(id)
      await refetch()
      return activated
    },
    removeProfile: async (id) => {
      await remove.mutateAsync(id)
      await refetch()
    },
    backupNow: async (id) => {
      const backupRow = await backup.mutateAsync(id)
      void queryClient.invalidateQueries({ queryKey: ['profile-backups'] })
      return backupRow
    },
    busy: create.isPending || clone.isPending || rename.isPending || activate.isPending || remove.isPending || backup.isPending,
  }
}
