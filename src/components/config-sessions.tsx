import { ArrowRotateRight, TrashBin } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Input, Spinner } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useDshSessionsInfinite } from '@/hooks/use-dsh-sessions-paged'
import type { SessionFileInfo } from '@/hooks/use-dsh-sessions'
import { toast } from '@/utils/toast'
import { Empty } from './empty'
import { Modal } from './modal'
import { PanelHeader } from './panel-header'
import { PanelState } from './panel-state'
import { SessionRow } from './session-row'

type FilterType = 'all' | 'active' | 'archived' | 'orphan'
type SortKey = 'createdAt' | 'size' | 'turns'

function truncatePreview(text: string, max = 24) {
  const tt = text.trim()
  return tt.length > max ? `${tt.slice(0, max)}…` : tt
}

function buildPreviewCapped(ids: string[], items: SessionFileInfo[], t: (k: string, o?: unknown) => string) {
  const raw = ids.slice(0, 3).map(id => truncatePreview(items.find(s => s.id === id)?.title || id))
  const preview = raw.join('、')
  const more = ids.length > 3 ? t('sessions.delete.batch_more', { count: ids.length - 3 }) as string : ''
  const text = preview + more
  return text.length > 72 ? `${text.slice(0, 72)}…` : text
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
  const areAllFilteredSelected = total > 0 && selected.size === total && (hasNextPage ? true : items.length === total && items.length > 0 && items.every(s => selected.has(s.id)))
  const isIndeterminate = !areAllFilteredSelected && selected.size > 0 && (hasNextPage ? selected.size < total : items.some(s => selected.has(s.id)))
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
      // 未加载完时需分片拉全量再全选，后端 clamp 5000，>5000 时需循环
      if (hasNextPage) {
        try {
          const chunk = 2000
          const ids: string[] = []
          for (let off = 0; off < total; off += chunk) {
            const page = await invoke<{ total: number, items: SessionFileInfo[] }>('get_session_files_paged', {
              filter,
              search: debouncedSearch || null,
              sortKey,
              sortAsc,
              offset: off,
              limit: Math.min(chunk, total - off),
            })
            for (const s of page.items) ids.push(s.id)
            if (page.items.length < chunk) break
          }
          if (ids.length > 0) setSelected(new Set(ids))
          else setSelected(new Set(items.map(s => s.id)))
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
    const previewCapped = buildPreviewCapped(ids, items, t as (k: string, o?: unknown) => string)
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
    const previewCapped = buildPreviewCapped(ids, items, t as (k: string, o?: unknown) => string)
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
