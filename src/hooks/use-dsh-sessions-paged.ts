import { useState } from 'react'
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
    void queryClient.invalidateQueries({ queryKey: ['dsh-sessions-paged'], refetchType: 'all' })
    void queryClient.invalidateQueries({ queryKey: ['dsh-sessions'], refetchType: 'all' })
  }
  const del = useMutation({
    mutationFn: (ids: string[]) => invoke<void>('delete_session_files', { ids }),
    onSuccess: () => invalidate(),
  })

  const restore = useMutation({
    mutationFn: (ids: string[]) => invoke<void>('restore_session_files', { ids }),
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
    restoreSessions: (ids: string[]) => restore.mutateAsync(ids),
    openDir: (id: string) => open.mutateAsync(id),
    deletePending: del.isPending,
    restorePending: restore.isPending,
    openId,
    openPending: open.isPending,
  }
}

export interface UseDshSessionsInfiniteParams {
  filter: 'all' | 'active' | 'archived' | 'orphan'
  search: string
  sortKey: 'createdAt' | 'size' | 'turns'
  sortAsc: boolean
}

const INFINITE_PAGE_SIZE = 1000

export function useDshSessionsInfinite(params: UseDshSessionsInfiniteParams) {
  const queryClient = useQueryClient()
  const [openId, setOpenId] = useState<string | null>(null)

  const infinite = useInfiniteQuery({
    queryKey: ['dsh-sessions-paged-infinite', params],
    queryFn: ({ pageParam = 0 }) => invoke<PagedSessionResult>('get_session_files_paged', {
      filter: params.filter,
      search: params.search || null,
      sortKey: params.sortKey,
      sortAsc: params.sortAsc,
      offset: pageParam as number,
      limit: INFINITE_PAGE_SIZE,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + p.items.length, 0)
      if (loaded >= lastPage.total || lastPage.items.length < INFINITE_PAGE_SIZE) return undefined
      return loaded
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    gcTime: 300_000,
  })

  const pages = infinite.data?.pages ?? []
  const items: SessionFileInfo[] = pages.flatMap(p => p.items)
  const total = pages[0]?.total ?? 0
  const counts = pages[0]?.counts ?? { all: 0, active: 0, archived: 0, orphan: 0 }
  const isParseFailed = pages[0]?.isParseFailed ?? false

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['dsh-sessions-paged-infinite'], refetchType: 'all' })
    void queryClient.invalidateQueries({ queryKey: ['dsh-sessions-paged'], refetchType: 'all' })
    void queryClient.invalidateQueries({ queryKey: ['dsh-sessions'], refetchType: 'all' })
  }
  const del = useMutation({
    mutationFn: (ids: string[]) => invoke<void>('delete_session_files', { ids }),
    onSuccess: () => invalidate(),
  })

  const restore = useMutation({
    mutationFn: (ids: string[]) => invoke<void>('restore_session_files', { ids }),
    onSuccess: () => invalidate(),
  })

  const open = useMutation({
    mutationFn: (id: string) => invoke<void>('open_session_dir', { id }),
    onMutate: id => setOpenId(id as string),
    onSettled: () => setOpenId(null),
  })

  return {
    items,
    total,
    counts,
    isParseFailed,
    loading: infinite.isLoading,
    fetching: infinite.isFetching,
    fetchingNextPage: infinite.isFetchingNextPage,
    hasNextPage: infinite.hasNextPage ?? false,
    fetchNextPage: infinite.fetchNextPage,
    error: infinite.error ? String(infinite.error) : '',
    refresh: () => void infinite.refetch(),
    deleteSessions: (ids: string[]) => del.mutateAsync(ids),
    restoreSessions: (ids: string[]) => restore.mutateAsync(ids),
    openDir: (id: string) => open.mutateAsync(id),
    deletePending: del.isPending,
    restorePending: restore.isPending,
    openId,
    openPending: open.isPending,
  }
}
