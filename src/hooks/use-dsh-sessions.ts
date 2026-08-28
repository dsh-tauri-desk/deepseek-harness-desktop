import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'

/** Rust 侧 service::session::SessionFileInfo 序列化形态（camelCase） */
export interface SessionFileInfo {
  id: string
  title: string | null
  size: number
  turns: number
  steps: number
  createdAt: number
  cwd: string
  archivedStatus: 'active' | 'archived' | 'orphan'
  isEmpty: boolean
  path: string
}

export interface UseDshSessionsResult {
  sessions: SessionFileInfo[]
  loading: boolean
  error: string
  refresh: () => void
  deleteSessions: (ids: string[]) => Promise<void>
  openDir: (id: string) => Promise<void>
  busy: boolean
  busyId: string | null
}

/**
 * 会话文件列表与操作（react-query）
 *
 * 查询键 `['dsh-sessions']`：调用 `get_session_files`（Rust 侧扫描文件系统 + 双 JSON 富化）
 */
export function useDshSessions(): UseDshSessionsResult {
  const queryClient = useQueryClient()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dsh-sessions'],
    queryFn: () => invoke<SessionFileInfo[]>('get_session_files'),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['dsh-sessions'] })
  }

  const del = useMutation({
    mutationFn: (ids: string[]) => invoke<void>('delete_session_files', { ids }),
    onSuccess: () => invalidate(),
  })

  const open = useMutation({
    mutationFn: (id: string) => invoke<void>('open_session_dir', { id }),
  })

  return {
    sessions: data ?? [],
    loading: isLoading,
    error: error ? String(error) : '',
    refresh: () => void refetch(),
    deleteSessions: (ids: string[]) => del.mutateAsync(ids),
    openDir: (id: string) => open.mutateAsync(id),
    busy: del.isPending || open.isPending,
    busyId: null,
  }
}
