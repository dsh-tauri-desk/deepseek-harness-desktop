import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'

export interface UseTrustModeResult {
  /** 信任模式是否已开启（默认预设为 `danger-full-access`） */
  enabled: boolean
  /** 首次读取中 */
  loading: boolean
  /** 切换写入中 */
  busy: boolean
  /** 切换信任模式（写 `$DSH_HOME/settings.yaml` 的权限预设） */
  setEnabled: (next: boolean) => Promise<void>
}

/**
 * 信任模式（Trust Mode）的读取与切换。
 *
 * 直接读写 Harness 官方的权限预设（`permissionPresets.defaultPreset`），
 * 真源是 `settings.yaml` 而非桌面端 store，因此在 Harness 界面里改过权限
 * 预设时，这里重开面板即可读到最新值，两边不会各持一套状态。
 *
 * 变更对**之后新建的会话**生效——会话创建时即固定其权限，既有会话不会被
 * 追溯改写，所以提示语应指向「新开会话」而非「重启服务」。
 */
export function useTrustMode(): UseTrustModeResult {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['trust-mode'],
    queryFn: () => invoke<boolean>('get_trust_mode'),
  })

  const toggle = useMutation({
    mutationFn: (next: boolean) => invoke<void>('set_trust_mode', { enabled: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['trust-mode'] })
    },
  })

  return {
    enabled: data ?? false,
    loading: isLoading,
    busy: toggle.isPending,
    setEnabled: async (next: boolean) => {
      await toggle.mutateAsync(next)
    },
  }
}
