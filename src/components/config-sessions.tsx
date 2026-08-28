import { ArrowRotateRight, FolderOpen, TrashBin } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Input, Spinner } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useDshSessions } from '@/hooks/use-dsh-sessions'
import type { SessionFileInfo } from '@/hooks/use-dsh-sessions'
import { toast } from '@/utils/toast'
import { Ellipsis } from './ellipsis'
import { Empty } from './empty'
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
  // 兼容 1787... 未来时间与正常时间戳
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString()
}

export function ConfigSessions() {
  const { t } = useTranslation()
  const { sessions, loading, error, refresh, deleteSessions, openDir, busy } = useDshSessions()

  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })
  const [filter, setFilter] = useState<FilterType>('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('createdAt')
  const [sortAsc, setSortAsc] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const filtered = sessions.filter((s) => {
    if (filter !== 'all' && s.archivedStatus !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      const title = (s.title ?? '').toLowerCase()
      if (!title.includes(q) && !s.id.toLowerCase().includes(q)) return false
    }
    return true
  })

  filtered.sort((a, b) => {
    let cmp = 0
    if (sortKey === 'size') cmp = a.size - b.size
    else if (sortKey === 'turns') cmp = a.turns - b.turns
    else cmp = a.createdAt - b.createdAt
    return sortAsc ? cmp : -cmp
  })

  const counts = {
    all: sessions.length,
    active: sessions.filter(s => s.archivedStatus === 'active').length,
    archived: sessions.filter(s => s.archivedStatus === 'archived').length,
    orphan: sessions.filter(s => s.archivedStatus === 'orphan').length,
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length && filtered.length > 0) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map(s => s.id)))
    }
  }

  async function handleDelete(ids: string[]) {
    if (ids.length === 0) return
    const preview = ids.slice(0, 3).map(id => sessions.find(s => s.id === id)?.title || id).join('、')
    const more = ids.length > 3 ? t('sessions.delete.batch_more', { count: ids.length - 3 }) : ''
    const confirmed = await openDialog({
      status: 'danger',
      title: t('sessions.delete.confirm_title'),
      description: ids.length === 1
        ? t('sessions.delete.confirm_desc_one', { title: preview })
        : t('sessions.delete.confirm_desc_batch', { count: ids.length, preview: preview + more }),
      confirmText: t('buttons.confirm'),
      cancelText: t('buttons.cancel'),
    })
    if (!confirmed) return
    try {
      await deleteSessions(ids)
      setSelected(new Set())
      toast(t('sessions.delete.success', { count: ids.length }))
    } catch (e) {
      toast(String(e), { timeout: 3000 })
    }
  }

  async function handleOpenDir(id: string) {
    try {
      await openDir(id)
    } catch (e) {
      toast(t('sessions.open_dir_failed') + ': ' + String(e), { timeout: 3000 })
    }
  }

  return (
    <div className="space-y-3">
      {dialogHolder}
      <PanelHeader
        title={t('config.sessions')}
        description={t('sessions.description')}
      />

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Input
            placeholder={t('sessions.search.placeholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1"
          />
          <Button variant="tertiary" onPress={() => refresh()} isDisabled={loading} aria-label={t('sessions.refresh')}>
            <If cond={loading} else={<><ArrowRotateRight className="size-4" />{t('sessions.refresh')}</>}>
              <Spinner size="sm" />
            </If>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', 'active', 'archived', 'orphan'] as FilterType[]).map(k => (
            <Chip
              key={k}
              variant={filter === k ? 'primary' : 'soft'}
              color={filter === k ? 'accent' : 'default'}
              onClick={() => setFilter(k)}
              className="cursor-pointer"
            >
              {t(`sessions.filter.${k}`)}
              {' '}
              ({counts[k]})
            </Chip>
          ))}
          <div className="ml-auto flex items-center gap-1">
            <span className="text-xs text-muted">{t('sessions.sort.label')}</span>
            <Button size="sm" variant={sortKey === 'createdAt' ? 'primary' : 'tertiary'} onPress={() => { setSortKey('createdAt'); setSortAsc(v => sortKey === 'createdAt' ? !v : false) }}>
              {t('sessions.sort.created_at')}
              {sortKey === 'createdAt' ? (sortAsc ? ' ↑' : ' ↓') : ''}
            </Button>
            <Button size="sm" variant={sortKey === 'size' ? 'primary' : 'tertiary'} onPress={() => { setSortKey('size'); setSortAsc(v => sortKey === 'size' ? !v : false) }}>
              {t('sessions.sort.size')}
              {sortKey === 'size' ? (sortAsc ? ' ↑' : ' ↓') : ''}
            </Button>
            <Button size="sm" variant={sortKey === 'turns' ? 'primary' : 'tertiary'} onPress={() => { setSortKey('turns'); setSortAsc(v => sortKey === 'turns' ? !v : false) }}>
              {t('sessions.sort.turns')}
              {sortKey === 'turns' ? (sortAsc ? ' ↑' : ' ↓') : ''}
            </Button>
          </div>
        </div>

        <If cond={selected.size > 0}>
          <div className="flex items-center gap-2 rounded-md border border-line bg-panel2 p-2">
            <span className="text-xs">{t('sessions.selected', { count: selected.size })}</span>
            <Button size="sm" variant="danger" onPress={() => handleDelete(Array.from(selected))} isDisabled={busy}>
              <TrashBin className="mr-1 size-4" />
              {t('sessions.delete.batch')}
            </Button>
            <Button size="sm" variant="tertiary" onPress={() => setSelected(new Set())}>
              {t('buttons.cancel')}
            </Button>
          </div>
        </If>
      </div>

      <PanelState loading={loading} error={error}>
        <If cond={filtered.length === 0} else={
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-1">
              <Checkbox isSelected={selected.size === filtered.length && filtered.length > 0} onChange={toggleSelectAll} />
              <span className="text-xs text-muted">{t('sessions.select_all')}</span>
              <span className="ml-auto text-xs text-muted">{t('sessions.total', { count: filtered.length })}</span>
            </div>
            {filtered.map((s: SessionFileInfo) => (
              <div
                key={s.id}
                className={`rounded-md border p-3 ${s.isEmpty ? 'border-warning/30 bg-warning/5' : 'border-line bg-panel2'}`}
              >
                <div className="flex items-start gap-2">
                  <Checkbox isSelected={selected.has(s.id)} onChange={() => toggleSelect(s.id)} className="mt-1" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <Ellipsis className="flex-1 text-sm font-medium">
                        {s.title || t('sessions.untitled')}
                      </Ellipsis>
                      <Chip
                        size="sm"
                        variant="soft"
                        color={s.archivedStatus === 'active' ? 'success' : s.archivedStatus === 'archived' ? 'warning' : 'default'}
                      >
                        {t(`sessions.status.${s.archivedStatus}`)}
                      </Chip>
                      <If cond={s.isEmpty}>
                        <Chip size="sm" variant="soft" color="warning">{t('sessions.empty')}</Chip>
                      </If>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      <span>{formatSize(s.size)}</span>
                      <span>turns {s.turns}</span>
                      <span>steps {s.steps}</span>
                      <span>{formatTime(s.createdAt)}</span>
                    </div>
                    <Ellipsis className="text-xs text-muted">{s.cwd || s.id}</Ellipsis>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="tertiary" onPress={() => handleOpenDir(s.id)} aria-label={t('sessions.open_dir')}>
                      <FolderOpen className="size-4" />
                    </Button>
                    <Button size="sm" variant="tertiary" onPress={() => handleDelete([s.id])} isDisabled={busy} aria-label={t('sessions.delete.one')}>
                      <TrashBin className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        }>
          <Empty>{t('sessions.empty_hint')}</Empty>
        </If>
      </PanelState>
    </div>
  )
}
