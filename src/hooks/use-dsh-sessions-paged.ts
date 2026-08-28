import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import type { SessionFileInfo } from './use-dsh-sessions'

export interface SessionCounts {
  all: number
  active: number
  archived: number
  orphan: number
}

export interface PagedSessionResult {
  total: number
  counts: SessionCounts
  items: SessionFileInfo[]
  isParseFailed: boolean
}

export interface UseDshSessionsPagedParams {
  filter: 'all' | 'active' | 'archived' | 'orphan'
  search: string
  sortKey: 'createdAt' | 'size' | 'turns'
  sortAsc: boolean
  offset: number
  limit: number
}

export function useDshSessionsPaged(params: UseDshSessionsPagedParams) {
  const queryClient = useQueryClient()
  const [openId, setOpenId] = useState<string | null>(null)

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['dsh-sessions-paged', params],
    queryFn: () => invoke<PagedSessionResult>('get_session_files_paged', {
      filter: params.filter,
      search: params.search || null,
      sortKey: params.sortKey,
      sortAsc: params.sortAsc,
      offset: params.offset,
      limit: params.limit,
    }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    gcTime: 300_000,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['dsh-sessions-paged'] })
    void queryClient.invalidateQueries({ queryKey: ['dsh-sessions'] })
  }

  const del = useMutation({
    mutationFn: (ids: string[]) => invoke<void>('delete_session_files', { ids }),
    onSuccess: () => invalidate(),
  })

  const open = useMutation({
    mutationFn: (id: string) => invoke<void>('open_session_dir', { id }),
    onMutate: id => setOpenId(id as string),
    onSettled: () => setOpenId(null),
  })

  return {
    total: data?.total ?? 0,
    counts: data?.counts ?? { all: 0, active: 0, archived: 0, orphan: 0 },
    items: data?.items ?? [],
    isParseFailed: data?.isParseFailed ?? false,
    loading: isLoading,
    fetching: isFetching,
    error: error ? String(error) : '',
    refresh: () => void refetch(),
    deleteSessions: (ids: string[]) => del.mutateAsync(ids),
    openDir: (id: string) => open.mutateAsync(id),
    deletePending: del.isPending,
    openId,
    openPending: open.isPending,
  }
}
