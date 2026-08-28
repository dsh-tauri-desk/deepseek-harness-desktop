import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'

/** Rust 侧 service::session::SessionFileInfo 序列化形态（camelCase） — 供分页与非分页共用 */
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
  isParseFailed?: boolean
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
  deletePending: boolean
  openPending: boolean
  openId: string | null
}

/**
 * 会话文件列表与操作（react-query）
 *
 * 查询键 `['dsh-sessions']`：调用 `get_session_files`（Rust 侧扫描文件系统 + 双 JSON 富化）
 */
export function useDshSessions(): UseDshSessionsResult {
  const queryClient = useQueryClient()
  const [openId, setOpenId] = useState<string | null>(null)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dsh-sessions'],
    queryFn: () => invoke<SessionFileInfo[]>('get_session_files'),
    staleTime: 30_000,
    gcTime: 300_000,
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
    onMutate: (id) => setOpenId(id),
    onSettled: () => setOpenId(null),
  })

  return {
    sessions: data ?? [],
    loading: isLoading,
    error: error ? String(error) : '',
    refresh: () => void refetch(),
    deleteSessions: (ids: string[]) => del.mutateAsync(ids),
    openDir: (id: string) => open.mutateAsync(id),
    busy: del.isPending || open.isPending,
    busyId: openId,
    deletePending: del.isPending,
    openPending: open.isPending,
    openId,
  }
}
