/**
 * components/task-create-dialog.tsx — 新建任务对话框。
 *
 * 外壳用官方 primitives `Modal`（居中弹层 + 标题/描述/关闭按钮/页脚），
 * 字段控件复刻官方样式：名称 = input 类；计划下拉 = input + selectInput 类；
 * 任务指令 = textarea 类；底部 composer 的 workspace / permission / 模型 三个
 * 选择器 = pill 触发按钮 + primitives `Menu`（官方 selector 模式，
 * 见 components/menu-select.tsx）。
 * 计划动态参数保持 #307 语义：每天/工作日=时间段；间隔=时长；每周=星期+时间段。
 */

import type { ReactElement } from 'react'
import type { LocaleKey, Translate } from '../locales/index.types'
import type { ScheduleForm, ScheduleKind, SchedulerOptions, TaskFormState, TaskInput, Weekday } from '../types'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { MenuSelect, useMountStyle } from 'dsh-tauri-ui/client'
import { isEmpty, map, omitBy, pick, range } from 'dsh-tauri/client'
import { useRef, useState } from 'react'
import { SCHEDULE_KINDS } from '../../shared/constants'
import { TASK_CREATE_DIALOG_STYLE_ID } from '../constants'
import { createTask, updateTask } from '../service/scheduler'
import { MenuHostProvider } from './menu'
import { ModelPicker } from './model-picker'
import taskCreateDialogStyle from './task-create-dialog.cssr'

export interface TaskCreateDialogProps {
  t: Translate
  options: SchedulerOptions
  /** 关闭回调（保存中忽略）。 */
  onClose: () => void
  /** 编辑模式：传入任务 id 时保存走 updateTask。 */
  taskId?: string
  /** 初始表单（编辑预填 / 推荐预填）；不传则新建空表单。 */
  initial?: TaskFormState
}

const WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const PERMISSION_LABEL_KEYS: Record<string, LocaleKey> = {
  'read-only': 'permissionReadOnly',
  'workspace-write': 'permissionWrite',
  'danger-full-access': 'permissionFullAccess',
}
const WEEKDAY_KEYS: Record<Weekday, LocaleKey> = {
  MO: 'dayMon',
  TU: 'dayTue',
  WE: 'dayWed',
  TH: 'dayThu',
  FR: 'dayFri',
  SA: 'daySat',
  SU: 'daySun',
}
const SCHEDULE_KIND_KEYS: Record<ScheduleKind, LocaleKey> = {
  once: 'scheduleOnce',
  hourly: 'scheduleHourly',
  daily: 'scheduleDaily',
  interval: 'scheduleInterval',
  workdays: 'scheduleWorkdays',
  weekly: 'scheduleWeekly',
  monthly: 'scheduleMonthly',
  custom: 'scheduleCustom',
}

/** 时间段选项：00:00 ~ 23:45，每 15 分钟一档。 */
const TIME_OPTIONS = range(96).map((index) => {
  const total = index * 15
  const h = String(Math.floor(total / 60)).padStart(2, '0')
  const m = String(total % 60).padStart(2, '0')
  return `${h}:${m}`
})

/** 表单里「空串即缺省」的可选字段（写入宿主前剔除）。 */
const OPTIONAL_INPUT_FIELDS = ['workspaceId', 'permission', 'provider', 'model', 'reasoningEffort'] as const

/** 间隔时长选项（分钟）。 */
const INTERVAL_OPTIONS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440]

/** 各计划模式的默认参数（切换模式时初始化，保证字段齐整）。 */
function defaultScheduleFor(kind: ScheduleForm['kind']): ScheduleForm {
  switch (kind) {
    case 'once':
      return { kind: 'once', at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
    case 'hourly':
      return { kind: 'hourly', minute: 0 }
    case 'interval':
      return { kind: 'interval', everyMinutes: 30 }
    case 'monthly':
      return { kind: 'monthly', day: 1, time: '09:00' }
    case 'custom':
      return { kind: 'custom', everyDays: 2, time: '09:00' }
    case 'weekly':
      return { kind: 'weekly', weekdays: ['MO'], time: '09:00' }
    case 'workdays':
      return { kind: 'workdays', time: '09:00' }
    default:
      return { kind: 'daily', time: '09:00' }
  }
}

export function TaskCreateDialog({ t, options, onClose, taskId, initial }: TaskCreateDialogProps): ReactElement {
  useMountStyle(taskCreateDialogStyle, TASK_CREATE_DIALOG_STYLE_ID)
  const [form, setForm] = useState<TaskFormState>(() => initial ?? {
    name: '',
    schedule: { kind: 'daily', time: '09:00' },
    prompt: '',
    workspaceId: '',
    permission: options.defaultPermission || 'read-only',
    // 照搬 dsh-automation defaultFormState：默认选中宿主默认模型（不出现空选择）。
    provider: options.defaultModel?.provider ?? '',
    model: options.defaultModel?.model ?? '',
    reasoningEffort: options.defaultModel?.reasoning?.defaultEffort ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [menuHost, setMenuHost] = useState<HTMLDivElement | null>(null)
  // 保存中禁止关闭（Esc / 遮罩 / 关闭按钮）：用 ref 供稳定闭包读取最新值。
  const savingRef = useRef(false)
  savingRef.current = saving

  function closeSafe(): void {
    if (savingRef.current)
      return
    onClose()
  }

  function setSchedule(patch: Partial<ScheduleForm>): void {
    setForm(state => ({ ...state, schedule: { ...state.schedule, ...patch } as ScheduleForm }))
  }

  async function onSave(): Promise<void> {
    setSaving(true)
    setError('')
    const input: TaskInput = {
      name: form.name,
      schedule: form.schedule,
      prompt: form.prompt,
      ...omitBy(pick(form, ...OPTIONAL_INPUT_FIELDS), isEmpty),
    }
    const result = await (taskId ? updateTask(taskId, input) : createTask(input))
    setSaving(false)
    if (!result.ok) {
      setError(result.error ?? t('createFailed'))
      return
    }
    onClose()
  }

  const scheduleKind = form.schedule.kind
  const currentTime = ('time' in form.schedule) ? form.schedule.time : '09:00'
  const currentEveryMinutes = form.schedule.kind === 'interval' ? form.schedule.everyMinutes : 30
  const currentWeekday: Weekday = form.schedule.kind === 'weekly' ? (form.schedule.weekdays[0] ?? 'MO') : 'MO'

  const workspaceOptions = [
    // Keep the empty id: the host interprets it as the ungrouped/default workspace.
    { id: '', label: t('workspaceDefault') },
    ...options.workspaces.map(ws => ({ id: ws.id, label: ws.title || ws.path })),
  ]
  // 权限选项：来自宿主 permissionPresets；缺失降级为常见三项（含完全访问）。
  const fallbackPermissions = [
    { id: 'read-only', label: t('permissionReadOnly') },
    { id: 'workspace-write', label: t('permissionWrite') },
    { id: 'danger-full-access', label: t('permissionFullAccess') },
  ]
  const permissionOptions = isEmpty(options.permissions)
    ? fallbackPermissions
    : map(options.permissions, option => ({
        id: option.value,
        label: PERMISSION_LABEL_KEYS[option.value] ? t(PERMISSION_LABEL_KEYS[option.value]) : option.name,
      }))
  // 编辑旧任务：当前值不在选项里时补一项，避免显示空值。
  if (form.permission && !permissionOptions.some(option => option.id === form.permission))
    permissionOptions.unshift({ id: form.permission, label: form.permission })

  const modelKey = form.provider && form.model ? `${form.provider}::${form.model}` : 'default'

  return (
    <MenuHostProvider host={menuHost}>
      <Modal
        open
        onClose={closeSafe}
        title={taskId ? t('editDialogTitle') : t('createDialogTitle')}
        description={t('dialogHint')}
        closeLabel={t('close')}
        className="dshp-scheduler__modal"
        footer={(
          <>
            <button className="dshp-scheduler__btn" type="button" disabled={saving} onClick={closeSafe}>{t('cancel')}</button>
            <button className={`${'dshp-scheduler__btn'} ${'dshp-scheduler__btn--primary'}`} type="button" disabled={saving} onClick={() => void onSave()}>
              {t('save')}
            </button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label className="dshp-scheduler__field">
            <span className="dshp-scheduler__field-label">{t('taskName')}</span>
            <input
              className="dshp-scheduler__input"
              type="text"
              value={form.name}
              placeholder={t('taskNamePlaceholder')}
              onChange={event => setForm(state => ({ ...state, name: event.target.value }))}
            />
          </label>

          <div className="dshp-scheduler__field">
            <span className="dshp-scheduler__field-label">{t('schedule')}</span>
            <div className="dshp-scheduler__inline">
              <select
                className={`${'dshp-scheduler__input'} ${'dshp-scheduler__select-input'} ${'dshp-scheduler__inline-select'}`}
                value={scheduleKind}
                aria-label={t('schedule')}
                onChange={event => setForm(state => ({ ...state, schedule: defaultScheduleFor(event.target.value as ScheduleForm['kind']) }))}
              >
                {SCHEDULE_KINDS.map(kind => (
                  <option key={kind} value={kind}>{t(SCHEDULE_KIND_KEYS[kind])}</option>
                ))}
              </select>

              {scheduleKind === 'once'
                ? <input className="dshp-scheduler__input dshp-scheduler__schedule-once" type="datetime-local" value={String(form.schedule.at).slice(0, 16)} onChange={event => setSchedule({ kind: 'once', at: new Date(event.target.value).toISOString() })} />
                : scheduleKind === 'hourly'
                  ? <select className="dshp-scheduler__input" value={form.schedule.minute} onChange={event => setSchedule({ kind: 'hourly', minute: Number(event.target.value) })}>{Array.from({ length: 60 }, (_, minute) => <option key={minute} value={minute}>{`: ${String(minute).padStart(2, '0')}`}</option>)}</select>
                  : scheduleKind === 'monthly'
                    ? (
                        <>
                          <input className="dshp-scheduler__input dshp-scheduler__inline-select--auto" type="number" min={1} max={31} value={form.schedule.kind === 'monthly' ? form.schedule.day : 1} aria-label={t('scheduleMonthDay')} onChange={event => setSchedule({ kind: 'monthly', day: Number(event.target.value), time: currentTime })} />
                          <select className="dshp-scheduler__input dshp-scheduler__select-input dshp-scheduler__inline-select--auto" value={currentTime} aria-label={t('scheduleTime')} onChange={event => setSchedule({ kind: 'monthly', day: form.schedule.kind === 'monthly' ? form.schedule.day : 1, time: event.target.value })}>{TIME_OPTIONS.map(time => <option key={time} value={time}>{time}</option>)}</select>
                        </>
                      )
                    : scheduleKind === 'custom'
                      ? (
                          <>
                            <input className="dshp-scheduler__input dshp-scheduler__inline-select--auto" type="number" min={1} max={366} value={form.schedule.kind === 'custom' ? form.schedule.everyDays : 1} aria-label={t('scheduleEveryDays')} onChange={event => setSchedule({ kind: 'custom', everyDays: Number(event.target.value), time: currentTime })} />
                            <span>{t('dayShort')}</span>
                            <select className="dshp-scheduler__input dshp-scheduler__select-input dshp-scheduler__inline-select--auto" value={currentTime} aria-label={t('scheduleTime')} onChange={event => setSchedule({ kind: 'custom', everyDays: form.schedule.kind === 'custom' ? form.schedule.everyDays : 1, time: event.target.value })}>{TIME_OPTIONS.map(time => <option key={time} value={time}>{time}</option>)}</select>
                          </>
                        )
                      : scheduleKind === 'interval'
                        ? (
                            <select
                              className={`${'dshp-scheduler__input'} ${'dshp-scheduler__select-input'} ${'dshp-scheduler__inline-select--auto'}`}
                              value={currentEveryMinutes}
                              aria-label={t('scheduleEveryMinutes')}
                              onChange={event => setSchedule({ kind: 'interval', everyMinutes: Number(event.target.value), anchor: form.schedule.kind === 'interval' ? form.schedule.anchor : undefined })}
                            >
                              {INTERVAL_OPTIONS.map(minutes => <option key={minutes} value={minutes}>{`${minutes} ${t('minuteShort')}`}</option>)}
                            </select>
                          )
                        : scheduleKind === 'weekly'
                          ? (
                              <>
                                <select
                                  className={`${'dshp-scheduler__input'} ${'dshp-scheduler__select-input'} ${'dshp-scheduler__inline-select--auto'}`}
                                  value={currentWeekday}
                                  aria-label={t('scheduleWeekdays')}
                                  onChange={event => setSchedule({ kind: 'weekly', weekdays: [event.target.value as Weekday], time: currentTime })}
                                >
                                  {WEEKDAYS.map(day => <option key={day} value={day}>{t(WEEKDAY_KEYS[day])}</option>)}
                                </select>
                                <select
                                  className={`${'dshp-scheduler__input'} ${'dshp-scheduler__select-input'} ${'dshp-scheduler__inline-select--auto'}`}
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
                                className={`${'dshp-scheduler__input'} ${'dshp-scheduler__select-input'} ${'dshp-scheduler__inline-select--auto'}`}
                                value={currentTime}
                                aria-label={t('scheduleTime')}
                                onChange={event => setSchedule({ ...form.schedule, time: event.target.value } as ScheduleForm)}
                              >
                                {TIME_OPTIONS.map(time => <option key={time} value={time}>{time}</option>)}
                              </select>
                            )}
            </div>
          </div>

          <div className="dshp-scheduler__field">
            <span className="dshp-scheduler__field-label">{t('schedulePrompt')}</span>
            <div className="dshp-scheduler__prompt-wrap">
              <textarea
                className="dshp-scheduler__textarea"
                value={form.prompt}
                placeholder={t('schedulePromptPlaceholder')}
                onChange={event => setForm(state => ({ ...state, prompt: event.target.value }))}
              />
              <div className="dshp-scheduler__composer">
                <MenuSelect
                  variant="pill"
                  label={t('workspace')}
                  value={form.workspaceId}
                  options={workspaceOptions}
                  onSelect={id => setForm(state => ({ ...state, workspaceId: id }))}
                />
                <MenuSelect
                  variant="pill"
                  label={t('permission')}
                  value={form.permission}
                  options={permissionOptions}
                  onSelect={id => setForm(state => ({ ...state, permission: id }))}
                />
                <div style={{ flex: 1 }} />
                <ModelPicker
                  t={t}
                  models={options.models ?? []}
                  failures={options.failures ?? []}
                  modelKey={modelKey}
                  reasoningEffort={form.reasoningEffort === '' ? 'none' : form.reasoningEffort}
                  onSelection={(nextKey, effort) => {
                  // 照搬 dsh-automation：modelKey = `${provider}::${model}`；'default' 仅在
                  // 目录无默认模型时出现（trigger 显示官方 fallback「选择模型」）。
                    const sep = nextKey.indexOf('::')
                    const provider = sep >= 0 ? nextKey.slice(0, sep) : ''
                    const model = sep >= 0 ? nextKey.slice(sep + 2) : ''
                    setForm(state => ({
                      ...state,
                      provider,
                      model,
                      // 'none' = 提供商默认 → 落库空串。
                      reasoningEffort: effort === 'none' ? '' : effort,
                    }))
                  }}
                />
              </div>
            </div>
          </div>
        </div>
        {error ? <p className="dshp-scheduler__error" role="alert">{error}</p> : null}
        <div className="dshp-scheduler__flyout-root" ref={setMenuHost} />
      </Modal>
    </MenuHostProvider>
  )
}
