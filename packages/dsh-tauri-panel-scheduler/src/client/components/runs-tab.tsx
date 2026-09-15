import type { ReactElement } from 'react'
import type { LocaleKey, Translate } from '../locales/index.types'
import type { RunView } from '../types'
import { useMountStyle } from 'dsh-tauri-ui/client'
import { RUNS_TAB_STYLE_ID } from '../constants'
import runsTabStyle from './runs-tab.cssr'
import { formatLocalTime } from './schedule.utils'

export interface RunsTabProps {
  t: Translate
  runs: readonly RunView[]
  onDelete: (id: string) => void
}

const STATUS_KEYS: Record<RunView['status'], LocaleKey> = {
  succeeded: 'succeeded',
  failed: 'failed',
  interrupted: 'interrupted',
  skipped: 'skipped',
  cancelled: 'cancelled',
  queued: 'queued',
  running: 'running',
}

export function RunsTab({ t, runs, onDelete }: RunsTabProps): ReactElement {
  useMountStyle(runsTabStyle, RUNS_TAB_STYLE_ID)
  if (runs.length === 0)
    return <p className="dshp-scheduler__empty">{t('emptyRuns')}</p>
  return (
    <>
      <ul className="dshp-scheduler__runs-list">
        {runs.map(run => (
          <li key={run.id} className="dshp-scheduler__run-row">
            <div className="dshp-scheduler__run-main">
              <span className="dshp-scheduler__run-name" title={run.taskName}>{run.taskName}</span>
              {run.error ? <p className="dshp-scheduler__run-error">{run.error}</p> : null}
            </div>
            <div className="dshp-scheduler__run-meta">
              {run.status !== 'succeeded' && <span className="dshp-scheduler__chip" data-status={run.status}>{t(STATUS_KEYS[run.status])}</span>}
              <span className="dshp-scheduler__run-time">{formatLocalTime(run.startedAt) ?? ''}</span>
              <button type="button" className="dshp-scheduler__run-delete" onClick={() => onDelete(run.id)} aria-label={t('deleteRun')}>{t('delete')}</button>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
