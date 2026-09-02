/**
 * components/task-create-dialog.tsx — 新建任务对话框。
 *
 * 字段：名称、计划模式选择（每天/间隔/工作日/每周 + 动态时间参数组件）、
 * 任务指令 textarea + workspace-select + mode-select + module-select、取消/保存。
 */

import type { ReactElement } from 'react'
import type { ScheduleForm, SchedulerOptions, TaskFormState, Translate, Weekday } from '../types'
import { useState } from 'react'
import { applyCreateTask } from '../store'

export interface TaskCreateDialogProps {
  t: Translate
  options: SchedulerOptions
  onClose: () => void
}

const WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

/** 计划模式标签键映射（用于分段选择器）。 */
const SCHEDULE_KIND_KEYS = ['daily', 'interval', 'workdays', 'weekly'] as const

export function TaskCreateDialog({ t, options, onClose }: TaskCreateDialogProps): ReactElement {
  const [form, setForm] = useState<TaskFormState>({
    name: '',
    schedule: { kind: 'daily', time: '09:00' },
    prompt: '',
    workspaceId: '',
    mode: '',
    module: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function setSchedule(patch: Partial<ScheduleForm>): void {
    setForm(state => ({ ...state, schedule: { ...state.schedule, ...patch } as ScheduleForm }))
  }

  async function onSave(): Promise<void> {
    setSaving(true)
    setError('')
    const schedule = { ...form.schedule } as Record<string, unknown>
    const result = await applyCreateTask({
      name: form.name,
      schedule,
      prompt: form.prompt,
      workspaceId: form.workspaceId || undefined,
      mode: form.mode || undefined,
      module: form.module || undefined,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error ?? t('createFailed'))
      return
    }
    onClose()
  }

  const scheduleKind = form.schedule.kind

  return (
    <div
      className="dsch-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget)
          onClose()
      }}
    >
      <div className="dsch-dialog" role="dialog" aria-modal="true" aria-label={t('createTask')}>
        <h3>{t('createTask')}</h3>

        <label className="dsch-field">
          <span>{t('taskName')}</span>
          <input
            className="dsch-input"
            type="text"
            value={form.name}
            placeholder={t('taskNamePlaceholder')}
            onChange={event => setForm(state => ({ ...state, name: event.target.value }))}
          />
        </label>

        <div className="dsch-field">
          <span>{t('schedule')}</span>
          <div className="dsch-segments" role="radiogroup" aria-label={t('schedule')}>
            {SCHEDULE_KIND_KEYS.map(kind => (
              <button
                key={kind}
                type="button"
                className="dsch-segment"
                role="radio"
                aria-checked={scheduleKind === kind}
                data-active={scheduleKind === kind ? 'true' : undefined}
                onClick={() => setForm(state => ({ ...state, schedule: { kind, time: '09:00' } as ScheduleForm }))}
              >
                {t(`schedule${kind.charAt(0).toUpperCase()}${kind.slice(1)}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="dsch-field">
          <span>{t('scheduleTime')}</span>
          {scheduleKind === 'interval'
            ? (
                <input
                  className="dsch-input"
                  type="number"
                  min={5}
                  step={5}
                  value={form.schedule.kind === 'interval' ? form.schedule.everyMinutes : 30}
                  aria-label={t('scheduleEveryMinutes')}
                  onChange={event => setSchedule({ kind: 'interval', everyMinutes: Math.max(1, Number(event.target.value) || 30) })}
                />
              )
            : (
                <input
                  className="dsch-input"
                  type="time"
                  value={form.schedule.kind === 'daily' || form.schedule.kind === 'workdays'
                    ? form.schedule.time
                    : form.schedule.time}
                  aria-label={t('scheduleTime')}
                  onChange={event => setSchedule({ ...form.schedule, time: event.target.value } as ScheduleForm)}
                />
              )}
        </div>

        {scheduleKind === 'weekly'
          ? (
              <div className="dsch-field">
                <span>{t('scheduleWeekdays')}</span>
                <div className="dsch-weekdays">
                  {WEEKDAYS.map((day) => {
                    const active = form.schedule.kind === 'weekly' && form.schedule.weekdays.includes(day)
                    return (
                      <button
                        key={day}
                        type="button"
                        className="dsch-weekday"
                        aria-pressed={active}
                        data-active={active ? 'true' : undefined}
                        onClick={() => {
                          if (form.schedule.kind !== 'weekly')
                            return
                          const weekdays = active
                            ? form.schedule.weekdays.filter(d => d !== day)
                            : [...form.schedule.weekdays, day]
                          setSchedule({ ...form.schedule, weekdays } as ScheduleForm)
                        }}
                      >
                        {day}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          : null}

        <label className="dsch-field">
          <span>{t('schedulePrompt')}</span>
          <textarea
            className="dsch-textarea"
            value={form.prompt}
            placeholder={t('schedulePromptPlaceholder')}
            onChange={event => setForm(state => ({ ...state, prompt: event.target.value }))}
          />
        </label>

        <div className="dsch-row">
          <label className="dsch-field" style={{ flex: '1' }}>
            <span>{t('workspace')}</span>
            <select
              className="dsch-select"
              value={form.workspaceId}
              onChange={event => setForm(state => ({ ...state, workspaceId: event.target.value }))}
            >
              <option value="">{t('workspaceDefault')}</option>
              {options.workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.title || ws.path}</option>)}
            </select>
          </label>
          <label className="dsch-field" style={{ flex: '1' }}>
            <span>{t('mode')}</span>
            <select
              className="dsch-select"
              value={form.mode}
              onChange={event => setForm(state => ({ ...state, mode: event.target.value }))}
            >
              <option value="">{t('modeDefault')}</option>
              {options.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
          </label>
          <label className="dsch-field" style={{ flex: '1' }}>
            <span>{t('module')}</span>
            <select
              className="dsch-select"
              value={form.module}
              onChange={event => setForm(state => ({ ...state, module: event.target.value }))}
            >
              <option value="">{t('moduleDefault')}</option>
              {options.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </label>
        </div>

        {error ? <p className="dsch-error" role="alert">{error}</p> : null}

        <div className="dsch-dialogFooter">
          <button className="dsch-button dsch-buttonGhost" type="button" onClick={onClose}>{t('cancel')}</button>
          <button className="dsch-button dsch-buttonPrimary" type="button" disabled={saving} onClick={() => void onSave()}>
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
