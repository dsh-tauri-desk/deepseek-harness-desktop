/**
 * components/runs-tab.tsx — 执行记录 tab：按开始时间倒序的 run 列表。
 */

import type { ReactElement } from 'react'
import type { RunView, Translate } from '../types'
import { formatLocalTime } from '../utils/schedule'

export interface RunsTabProps {
  t: Translate
  runs: RunView[]
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

export function RunsTab({ t, runs }: RunsTabProps): ReactElement {
  if (runs.length === 0)
    return <p className="dsch-empty">{t('emptyRuns')}</p>
  return (
    <ul className="dsch-runsList">
      {runs.map(run => (
        <li key={run.id} className="dsch-runRow">
          <span className="dsch-runName" title={run.taskName}>{run.taskName}</span>
          <span className="dsch-chip" data-status={run.status}>{statusKey(t, run.status)}</span>
          <span className="dsch-chip">{run.trigger === 'manual' ? t('triggerManual') : t('triggerSchedule')}</span>
          <span className="dsch-runTime">{formatLocalTime(run.startedAt) ?? ''}</span>
          {run.error ? <p className="dsch-runError">{run.error}</p> : null}
        </li>
      ))}
    </ul>
  )
}
