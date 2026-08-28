import { ArrowRotateRight, FolderOpen, TrashBin } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Input, Label, Spinner } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useDshSessionsInfinite } from '@/hooks/use-dsh-sessions-paged'
import type { SessionFileInfo } from '@/hooks/use-dsh-sessions'
import { toast } from '@/utils/toast'
import { Ellipsis } from './ellipsis'
import { Empty } from './empty'
import { Item } from './item'
import { Modal } from './modal'
import { PanelHeader } from './panel-header'
import { PanelState } from './panel-state'

type FilterType = 'all' | 'active' | 'archived' | 'orphan'
type SortKey = 'createdAt' | 'size' | 'turns'
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTime(ts: number) {
  if (!ts) return '-'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString()
}

function statusChipColor(status: SessionFileInfo['archivedStatus']) {
  if (status === 'active') return 'success' as const
  if (status === 'archived') return 'warning' as const
  return 'default' as const
}

interface SessionRowProps {
  session: SessionFileInfo
  selected: boolean
  onToggle: () => void
  onDelete: () => void
  onRestore: () => void
  onOpenDir: () => void
  deletePending: boolean
  restorePending: boolean
  isOpening: boolean
}

function SessionRow({ session: s, selected, onToggle, onDelete, onRestore, onOpenDir, deletePending, restorePending, isOpening }: SessionRowProps) {
  const { t } = useTranslation()
  return (
    <Item
      left={(
        <div className="min-w-0 flex flex-col gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Checkbox
              isSelected={selected}
              onChange={onToggle}
              isDisabled={deletePending}
              aria-label={s.id}
              className="shrink-0"
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
              </Checkbox.Content>
            </Checkbox>
            <Label className="min-w-0 truncate text-sm font-medium text-ink">
              {s.title || t('sessions.untitled')}
            </Label>
            <Chip size="sm" variant="soft" color={statusChipColor(s.archivedStatus)} className="shrink-0 rounded-md font-medium">
              {t(`sessions.status.${s.archivedStatus}`)}
            </Chip>
            <If cond={s.isEmpty}>
              <Chip size="sm" variant="soft" color="warning" className="shrink-0 rounded-md font-medium">
                {t('sessions.empty')}
              </Chip>
            </If>
            <If cond={!!s.isParseFailed}>
              <Chip size="sm" variant="soft" color="danger" className="shrink-0 rounded-md font-medium">
                {t('sessions.parse_failed')}
              </Chip>
            </If>
          </div>
          <div className="ml-7 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>{formatSize(s.size)}</span>
            <span>
              turns
              {' '}
              {s.turns}
            </span>
            <span>
              steps
              {' '}
              {s.steps}
            </span>
            <span>{formatTime(s.createdAt)}</span>
          </div>
          <Ellipsis className="ml-7 text-xs text-muted">
            {s.cwd || s.id}
          </Ellipsis>
        </div>
      )}
      right={(
        <>
          <If cond={s.archivedStatus === 'archived'}>
            <Button
              size="sm"
              variant="tertiary"
              className="h-6 w-6 shrink-0 rounded-md p-0"
              onPress={onRestore}
              isDisabled={restorePending || deletePending || isOpening}
              aria-label={t('sessions.restore.one')}
            >
              <If cond={restorePending} else={<ArrowRotateRight className="size-3.5 scale-x-[-1]" />}>
                <Spinner size="sm" color="current" />
              </If>
            </Button>
          </If>
          <Button
            size="sm"
            variant="tertiary"
            className="h-6 w-6 shrink-0 rounded-md p-0"
            onPress={onOpenDir}
            isDisabled={isOpening || deletePending || restorePending}
            aria-label={t('sessions.open_dir')}
          >
            <If cond={isOpening} else={<FolderOpen className="size-3.5" />}>
              <Spinner size="sm" color="current" />
            </If>
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            className="h-6 w-6 shrink-0 rounded-md p-0"
            onPress={onDelete}
            isDisabled={deletePending || isOpening || restorePending}
            aria-label={t('sessions.delete.one')}
          >
            <TrashBin className="size-3.5" />
          </Button>
        </>
      )}
    />
  )
}

export function ConfigSessions() {
  const { t } = useTranslation()
  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })
  const [filter, setFilter] = useState<FilterType>('all')
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('createdAt')
  const [sortAsc, setSortAsc] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput), 300)
    return () => clearTimeout(id)
  }, [searchInput])

  // 无限分页：每页 500，虚拟化只渲染可视行，支撑 2000+ 任意总量
  const { items, total, counts, isParseFailed, loading, fetching, fetchingNextPage, hasNextPage, fetchNextPage, error, refresh, deleteSessions, restoreSessions, openDir, deletePending, restorePending, openId } = useDshSessionsInfinite({
    filter,
    search: debouncedSearch,
    sortKey,
    sortAsc,
  })
  const areAllFilteredSelected = total > 0 && selected.size === total && (hasNextPage ? true : items.length > 0 && items.every(s => selected.has(s.id)))
  const isIndeterminate = !areAllFilteredSelected && selected.size > 0 && (hasNextPage ? true : items.some(s => selected.has(s.id)))

  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: hasNextPage ? items.length + 1 : items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88,
    overscan: 10,
  })

  // 滚动接近底部自动加载下一页
  const virtualItems = rowVirtualizer.getVirtualItems()
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1]
    if (!last) return
    if (last.index >= items.length - 20 && hasNextPage && !fetchingNextPage) {
      void fetchNextPage()
    }
  }, [virtualItems, items.length, hasNextPage, fetchingNextPage, fetchNextPage])

  // 切换筛选/搜索时清空已选（避免跨筛选残留）
  useEffect(() => {
    setSelected(new Set())
  }, [filter, debouncedSearch, sortKey, sortAsc])


  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function toggleSelectAll() {
    if (areAllFilteredSelected) {
      setSelected(new Set())
    } else {
      // 未加载完时需先拉全量再全选，否则仅选中已加载的 500/1000 条会导致“删不完”
      if (hasNextPage) {
        try {
          const all = await invoke<{ total: number, items: SessionFileInfo[] }>('get_session_files_paged', {
            filter,
            search: debouncedSearch || null,
            sortKey,
            sortAsc,
            offset: 0,
            limit: total,
          })
          setSelected(new Set(all.items.map(s => s.id)))
        } catch {
          // 兜底：至少选中已加载的
          setSelected(new Set(items.map(s => s.id)))
        }
      } else {
        setSelected(new Set(items.map(s => s.id)))
      }
    }
  }
  async function handleDelete(ids: string[]) {
    if (ids.length === 0) return
    function truncatePreview(text: string, max = 24) {
      const tt = text.trim()
      return tt.length > max ? `${tt.slice(0, max)}…` : tt
    }
    const rawPreview = ids.slice(0, 3).map(id => truncatePreview(items.find(s => s.id === id)?.title || sessionsFallbackTitle(id)))
    const preview = rawPreview.join('、')
    const more = ids.length > 3 ? t('sessions.delete.batch_more', { count: ids.length - 3 }) : ''
    const previewText = preview + more
    const previewCapped = previewText.length > 72 ? `${previewText.slice(0, 72)}…` : previewText
    const confirmed = await openDialog({
      status: 'danger',
      title: t('sessions.delete.confirm_title'),
      description: ids.length === 1
        ? t('sessions.delete.confirm_desc_one', { title: previewCapped })
        : t('sessions.delete.confirm_desc_batch', { count: ids.length, preview: previewCapped }),
      confirmText: t('buttons.confirm'),
      cancelText: t('buttons.cancel'),
    })
    if (!confirmed) return
    try {
      for (let i = 0; i < ids.length; i += 100) {
        // eslint-disable-next-line no-await-in-loop
        await deleteSessions(ids.slice(i, i + 100))
      }
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      toast(t('sessions.delete.success', { count: ids.length }))
    } catch (e) {
      toast(String(e), { timeout: 3000 })
    }
  }

  async function handleRestore(ids: string[]) {
    if (ids.length === 0) return
    function truncatePreview(text: string, max = 24) {
      const tt = text.trim()
      return tt.length > max ? `${tt.slice(0, max)}…` : tt
    }
    const rawPreview = ids.slice(0, 3).map(id => truncatePreview(items.find(s => s.id === id)?.title || id))
    const preview = rawPreview.join('、')
    const more = ids.length > 3 ? t('sessions.delete.batch_more', { count: ids.length - 3 }) : ''
    const previewText = preview + more
    const previewCapped = previewText.length > 72 ? `${previewText.slice(0, 72)}…` : previewText
    const confirmed = await openDialog({
      status: 'accent',
      title: t('sessions.restore.confirm_title'),
      description: ids.length === 1
        ? t('sessions.restore.confirm_desc_one', { title: previewCapped })
        : t('sessions.restore.confirm_desc_batch', { count: ids.length, preview: previewCapped }),
      confirmText: t('buttons.confirm'),
      cancelText: t('buttons.cancel'),
    })
    if (!confirmed) return
    try {
      for (let i = 0; i < ids.length; i += 100) {
        // eslint-disable-next-line no-await-in-loop
        await restoreSessions(ids.slice(i, i + 100))
      }
      setSelected(new Set())
      toast(t('sessions.restore.success', { count: ids.length }))
    } catch (e) {
      toast(String(e), { timeout: 3000 })
    }
  }

  function sessionsFallbackTitle(id: string) {
    return id
  }
  async function handleOpenDir(id: string) {
    try {
      await openDir(id)
    } catch (e) {
      toast(`${t('sessions.open_dir_failed')}: ${String(e)}`, { timeout: 3000 })
    }
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-hidden">
      {dialogHolder}
      <PanelHeader
        title={t('config.sessions')}
        description={t('sessions.description')}
      />

      <If cond={isParseFailed}>
        <div className="rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning">
          {t('sessions.parse_failed_warning')}
        </div>
      </If>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Input
            variant="secondary"
            className="h-8 flex-1 rounded-md"
            placeholder={t('sessions.search.placeholder')}
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
          />
          <Button
            size="sm"
            variant="tertiary"
            className="h-8 rounded-md"
            onPress={() => refresh()}
            isDisabled={loading}
            aria-label={t('sessions.refresh')}
          >
            <If cond={loading} else={<><ArrowRotateRight className="size-3.5" />{t('sessions.refresh')}</>}>
              <Spinner size="sm" color="current" />
            </If>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', 'active', 'archived', 'orphan'] as FilterType[]).map(k => (
            <Chip
              key={k}
              size="sm"
              variant={filter === k ? 'primary' : 'soft'}
              color={filter === k ? 'accent' : 'default'}
              className="shrink-0 cursor-pointer rounded-md font-medium"
              role="button"
              tabIndex={0}
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setFilter(k)
                }
              }}
            >
              {t(`sessions.filter.${k}`)}
              {' '}
              ({counts[k as keyof typeof counts]})
            </Chip>
          ))}
          <div className="ml-auto flex items-center gap-1">
            <span className="text-xs text-muted">{t('sessions.sort.label')}</span>
            <Button size="sm" variant={sortKey === 'createdAt' ? 'primary' : 'tertiary'} className="h-7 rounded-md text-xs" onPress={() => { setSortKey('createdAt'); setSortAsc(v => sortKey === 'createdAt' ? !v : false) }}>
              {t('sessions.sort.created_at')}
              {sortKey === 'createdAt' ? (sortAsc ? ' ↑' : ' ↓') : ''}
            </Button>
            <Button size="sm" variant={sortKey === 'size' ? 'primary' : 'tertiary'} className="h-7 rounded-md text-xs" onPress={() => { setSortKey('size'); setSortAsc(v => sortKey === 'size' ? !v : false) }}>
              {t('sessions.sort.size')}
              {sortKey === 'size' ? (sortAsc ? ' ↑' : ' ↓') : ''}
            </Button>
            <Button size="sm" variant={sortKey === 'turns' ? 'primary' : 'tertiary'} className="h-7 rounded-md text-xs" onPress={() => { setSortKey('turns'); setSortAsc(v => sortKey === 'turns' ? !v : false) }}>
              {t('sessions.sort.turns')}
              {sortKey === 'turns' ? (sortAsc ? ' ↑' : ' ↓') : ''}
            </Button>
          </div>
        </div>

        <If cond={selected.size > 0}>
          <div className="flex items-center gap-2 rounded-md border border-line bg-panel2 p-2">
            <span className="text-xs text-muted">{t('sessions.selected', { count: selected.size })}</span>
            <If cond={Array.from(selected).some(id => items.find(s => s.id === id)?.archivedStatus === 'archived')}>
              <Button
                size="sm"
                variant="primary"
                className="h-7 rounded-md"
                onPress={() => {
                  const archivedIds = Array.from(selected).filter(id => items.find(s => s.id === id)?.archivedStatus === 'archived')
                  void handleRestore(archivedIds)
                }}
                isDisabled={restorePending || deletePending}
              >
                <If cond={restorePending} else={<ArrowRotateRight className="mr-1 size-3.5 scale-x-[-1]" />}>
                  <Spinner size="sm" color="current" />
                </If>
                {t('sessions.restore.batch')}
              </Button>
            </If>
            <Button
              size="sm"
              variant="danger"
              className="h-7 rounded-md"
              onPress={() => handleDelete(Array.from(selected))}
              isDisabled={deletePending || restorePending}
            >
              <If cond={deletePending} else={<TrashBin className="mr-1 size-3.5" />}>
                <Spinner size="sm" color="current" />
              </If>
              {t('sessions.delete.batch')}
            </Button>
            <Button size="sm" variant="tertiary" className="h-7 rounded-md" onPress={() => setSelected(new Set())} isDisabled={deletePending || restorePending}>
              {t('buttons.cancel')}
            </Button>
          </div>
        </If>
      </div>

      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        <PanelState loading={loading} error={error}>
        <If
          cond={items.length === 0}
          else={(
            <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-hidden">
              <div className="flex items-center gap-2 px-1">
                <Checkbox
                  isSelected={areAllFilteredSelected}
                  isIndeterminate={isIndeterminate}
                  onChange={toggleSelectAll}
                  isDisabled={deletePending || restorePending}
                  aria-label={t('sessions.select_all')}
                  className="shrink-0"
                >
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                  </Checkbox.Content>
                </Checkbox>
                <span className="text-xs text-muted">{t('sessions.select_all')}</span>
                <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                  <If cond={fetching && !loading}>
                    <Spinner size="sm" color="current" />
                  </If>
                  {t('sessions.total', { count: total })}
                </span>
              </div>

              <div ref={parentRef} className="flex-1 min-h-0 overflow-auto rounded-md border border-line/30">
                <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
                  {rowVirtualizer.getVirtualItems().map(virtualRow => {
                    const isLoader = virtualRow.index >= items.length
                    if (isLoader) {
                      return (
                        <div
                          key="loader"
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                          className="flex items-center justify-center p-4"
                        >
                          <If cond={hasNextPage} then={<Spinner size="sm" color="current" />} else={<span className="text-xs text-muted">{t('sessions.loaded_all', { count: total })}</span>} />
                        </div>
                      )
                    }
                    const s = items[virtualRow.index]!
                    return (
                      <div
                        key={s.id}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                        className="p-1"
                      >
                        <SessionRow
                          session={s}
                          selected={selected.has(s.id)}
                          onToggle={() => toggleSelect(s.id)}
                          onDelete={() => handleDelete([s.id])}
                          onRestore={() => handleRestore([s.id])}
                          onOpenDir={() => handleOpenDir(s.id)}
                          deletePending={deletePending}
                          restorePending={restorePending}
                          isOpening={openId === s.id}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
              <If cond={hasNextPage}>
                <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted">
                  <span>{t('sessions.loaded_count', { loaded: items.length, total })}</span>
                  <If cond={fetchingNextPage} then={<Spinner size="sm" color="current" />} />
                  <Button size="sm" variant="tertiary" className="h-6 rounded-md" onPress={() => void fetchNextPage()} isDisabled={fetchingNextPage}>
                    {t('sessions.load_more')}
                  </Button>
                </div>
              </If>
            </div>
          )}
        >
          <Empty>
            {total === 0 && debouncedSearch === '' && filter === 'all' ? t('sessions.empty_hint') : t('sessions.search.empty')}
          </Empty>
        </If>
      </PanelState>
      </div>
    </div>
  )
}
