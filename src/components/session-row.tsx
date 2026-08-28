import { ArrowRotateRight, FolderOpen, TrashBin } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Spinner } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import type { SessionFileInfo } from '@/hooks/use-dsh-sessions'
import { Ellipsis } from './ellipsis'
import { Item } from './item'

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

export interface SessionRowProps {
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

export function SessionRow({ session: s, selected, onToggle, onDelete, onRestore, onOpenDir, deletePending, restorePending, isOpening }: SessionRowProps) {
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
              aria-label={s.title || s.id}
              className="shrink-0"
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
              </Checkbox.Content>
            </Checkbox>
            <span className="min-w-0 truncate text-sm font-medium text-ink">
              {s.title || t('sessions.untitled')}
            </span>
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
            <span>{t('sessions.stat.turns', { count: s.turns })}</span>
            <span>{t('sessions.stat.steps', { count: s.steps })}</span>
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
