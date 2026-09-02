/**
 * components/task-create-dialog.tsx — 新建任务对话框。
 *
 * 布局对齐 issue #307 的 ASCII 设计图，控件一律用原生
 * <input>/<select>/<textarea>/<button>（DeepSeek 设计令牌样式，不自绘）：
 *   标题 + [X] → 提示「请编写完整、独立的任务说明…」→ 名称
 *   → 计划（模式 Select + 动态参数：每天/工作日=时间段 Select；间隔=时长 Select；
 *      每周=星期周期 Select + 时间段 Select）
 *   → 任务指令 textarea + 底部 composer（workspace / mode / module 三个 Select）
 *   → 取消 / 保存。
 */

import type { ReactElement } from 'react'
import type { ScheduleForm, SchedulerOptions, TaskFormState, Translate, Weekday } from '../types'
import { useEffect, useRef, useState } from 'react'
import { applyCreateTask } from '../store'
import { IconClose } from './icons'

export interface TaskCreateDialogProps {
  t: Translate
  options: SchedulerOptions
  onClose: () => void
}

const WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const WEEKDAY_KEYS: Record<Weekday, string> = {
  MO: 'dayMon',
  TU: 'dayTue',
  WE: 'dayWed',
  TH: 'dayThu',
  FR: 'dayFri',
  SA: 'daySat',
  SU: 'daySun',
}

/** 时间段选项：00:00 ~ 23:45，每 15 分钟一档。 */
const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const total = index * 15
  const h = String(Math.floor(total / 60)).padStart(2, '0')
  const m = String(total % 60).padStart(2, '0')
  return `${h}:${m}`
})

/** 间隔时长选项（分钟）。 */
const INTERVAL_OPTIONS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440]

const SCHEDULE_KINDS = ['daily', 'interval', 'workdays', 'weekly'] as const

/** 各计划模式的默认参数（切换模式时初始化，保证字段齐整）。 */
function defaultScheduleFor(kind: ScheduleForm['kind']): ScheduleForm {
  switch (kind) {
    case 'interval':
      return { kind: 'interval', everyMinutes: 30 }
    case 'weekly':
      return { kind: 'weekly', weekdays: ['MO'], time: '09:00' }
    case 'workdays':
      return { kind: 'workdays', time: '09:00' }
    default:
      return { kind: 'daily', time: '09:00' }
  }
}

function kindLabelKey(kind: (typeof SCHEDULE_KINDS)[number]): string {
  return `schedule${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
}

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
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // 保存中禁止关闭（Esc / 遮罩 / 取消 / [X]）：用 ref 供稳定闭包读取最新值。
  const savingRef = useRef(false)
  savingRef.current = saving

  function closeSafe(): void {
    if (savingRef.current)
      return
    onClose()
  }

  // 模态对话框基础键盘行为：挂载聚焦、Esc 关闭、卸载还原焦点。
  // onClose 经 ref 读取，避免 effect 依赖每次渲染重建的 closeSafe。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    dialog?.focus()
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !savingRef.current)
        onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [])

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
  const currentTime = (form.schedule.kind === 'daily' || form.schedule.kind === 'workdays' || form.schedule.kind === 'weekly')
    ? form.schedule.time
    : '09:00'
  const currentEveryMinutes = form.schedule.kind === 'interval' ? form.schedule.everyMinutes : 30
  const currentWeekday: Weekday = form.schedule.kind === 'weekly' ? (form.schedule.weekdays[0] ?? 'MO') : 'MO'

  return (
    <div
      className="dsch-mask"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget)
          closeSafe()
      }}
    >
      <div className="dsch-dialog" role="dialog" aria-modal="true" aria-label={t('createDialogTitle')} tabIndex={-1} ref={dialogRef}>
        <div className="dsch-dialogHead">
          <div>
            <h2>{t('createDialogTitle')}</h2>
            <p>{t('dialogHint')}</p>
          </div>
          <button className="dsch-dialogClose" type="button" aria-label={t('close')} onClick={closeSafe}>
            <IconClose />
          </button>
        </div>

        <label className="dsch-field">
          <span className="dsch-fieldLabel">{t('taskName')}</span>
          <input
            type="text"
            value={form.name}
            placeholder={t('taskNamePlaceholder')}
            onChange={event => setForm(state => ({ ...state, name: event.target.value }))}
          />
        </label>

        <div className="dsch-field">
          <span className="dsch-fieldLabel">{t('schedule')}</span>
          <div className="dsch-inline">
            <select
              className="dsch-select"
              value={scheduleKind}
              aria-label={t('schedule')}
              onChange={event => setForm(state => ({ ...state, schedule: defaultScheduleFor(event.target.value as ScheduleForm['kind']) }))}
            >
              {SCHEDULE_KINDS.map(kind => (
                <option key={kind} value={kind}>{t(kindLabelKey(kind))}</option>
              ))}
            </select>

            {scheduleKind === 'interval'
              ? (
                  <select
                    className="dsch-select dsch-select--auto"
                    value={currentEveryMinutes}
                    aria-label={t('scheduleEveryMinutes')}
                    onChange={event => setSchedule({ kind: 'interval', everyMinutes: Number(event.target.value) })}
                  >
                    {INTERVAL_OPTIONS.map(minutes => <option key={minutes} value={minutes}>{`${minutes} ${t('minuteShort')}`}</option>)}
                  </select>
                )
              : scheduleKind === 'weekly'
                ? (
                    <>
                      <select
                        className="dsch-select dsch-select--auto"
                        value={currentWeekday}
                        aria-label={t('scheduleWeekdays')}
                        onChange={event => setSchedule({ kind: 'weekly', weekdays: [event.target.value as Weekday], time: currentTime })}
                      >
                        {WEEKDAYS.map(day => <option key={day} value={day}>{t(WEEKDAY_KEYS[day])}</option>)}
                      </select>
                      <select
                        className="dsch-select dsch-select--auto"
                        value={currentTime}
                        aria-label={t('scheduleTime')}
                        onChange={event => setSchedule({ ...form.schedule, time: event.target.value } as ScheduleForm)}
                      >
                        {TIME_OPTIONS.map(time => <option key={time} value={time}>{time}</option>)}
                      </select>
                    </>
                  )
                : (
                    <select
                      className="dsch-select dsch-select--auto"
                      value={currentTime}
                      aria-label={t('scheduleTime')}
                      onChange={event => setSchedule({ ...form.schedule, time: event.target.value } as ScheduleForm)}
                    >
                      {TIME_OPTIONS.map(time => <option key={time} value={time}>{time}</option>)}
                    </select>
                  )}
          </div>
        </div>

        <div className="dsch-field">
          <span className="dsch-fieldLabel">{t('schedulePrompt')}</span>
          <textarea
            value={form.prompt}
            placeholder={t('schedulePromptPlaceholder')}
            onChange={event => setForm(state => ({ ...state, prompt: event.target.value }))}
          />
        </div>

        <div className="dsch-composer">
          <select
            className="dsch-select"
            value={form.workspaceId}
            aria-label={t('workspace')}
            title={t('workspace')}
            onChange={event => setForm(state => ({ ...state, workspaceId: event.target.value }))}
          >
            <option value="">{t('workspaceDefault')}</option>
            {options.workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.title || ws.path}</option>)}
          </select>
          <select
            className="dsch-select"
            value={form.mode}
            aria-label={t('mode')}
            title={t('mode')}
            onChange={event => setForm(state => ({ ...state, mode: event.target.value }))}
          >
            <option value="">{t('mode')}</option>
            {options.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
          <select
            className="dsch-select"
            value={form.module}
            aria-label={t('module')}
            title={t('module')}
            onChange={event => setForm(state => ({ ...state, module: event.target.value }))}
          >
            <option value="">{t('moduleDefault')}</option>
            {options.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </div>

        {error ? <p className="dsch-error" role="alert">{error}</p> : null}

        <div className="dsch-dialogFooter">
          <button className="dsch-btn" type="button" disabled={saving} onClick={closeSafe}>{t('cancel')}</button>
          <button className="dsch-btn dsch-btn--primary" type="button" disabled={saving} onClick={() => void onSave()}>
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
