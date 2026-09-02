/**
 * components/runs-tab.tsx — 执行记录 tab：按开始时间倒序的 run 列表。
 */

import type { ReactElement } from 'react'
import type { RunView, Translate } from '../types'
import { SCHEDULER_CLASSES as K } from '../constants'
import { formatLocalTime } from '../utils/schedule'

export interface RunsTabProps {
  t: Translate
  runs: RunView[]
  onDelete: (id: string) => void
  onClear: () => void
}

function statusKey(t: Translate, status: RunView['status']): string {
  switch (status) {
    case 'succeeded': return t('succeeded')
    case 'failed': return t('failed')
    case 'skipped': return t('skipped')
    case 'cancelled': return t('cancelled')
    case 'queued': return t('queued')
    case 'running': return t('running')
  }
}

export function RunsTab({ t, runs, onDelete, onClear }: RunsTabProps): ReactElement {
  if (runs.length === 0)
    return <p className={K.empty}>{t('emptyRuns')}</p>
  return (
    <>
      <div className={K.runsToolbar}>
        <button type="button" className={K.btnDanger} onClick={onClear}>{t('clearRuns')}</button>
      </div>
      <ul className={K.runsList}>
        {runs.map(run => (
          <li key={run.id} className={K.runRow}>
            <div className={K.runMain}>
              <span className={K.runName} title={run.taskName}>{run.taskName}</span>
              {run.error ? <p className={K.runError}>{run.error}</p> : null}
            </div>
            <div className={K.runMeta}>
              <span className={K.chip} data-status={run.status}>{statusKey(t, run.status)}</span>
              <span className={K.chip}>{run.trigger === 'manual' ? t('triggerManual') : t('triggerSchedule')}</span>
              <span className={K.runTime}>{formatLocalTime(run.startedAt) ?? ''}</span>
              <button type="button" className={K.runDelete} onClick={() => onDelete(run.id)} aria-label={t('deleteRun')}>{t('delete')}</button>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
