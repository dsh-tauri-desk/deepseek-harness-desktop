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
import type { ScheduleForm, SchedulerOptions, TaskFormState, Translate, Weekday } from '../types'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useRef, useState } from 'react'
import { SCHEDULER_CLASSES as K } from '../constants'
import { applyCreateTask, applyUpdateTask } from '../store'
import { MenuSelect } from './menu-select'
import { ModelPicker } from './model-picker'

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

export function TaskCreateDialog({ t, options, onClose, taskId, initial }: TaskCreateDialogProps): ReactElement {
  const [form, setForm] = useState<TaskFormState>(() => initial ?? {
    name: '',
    schedule: { kind: 'daily', time: '09:00' },
    prompt: '',
    workspaceId: '',
    permission: options.defaultPermission || 'read-only',
    provider: '',
    model: '',
    reasoningEffort: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
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
    const schedule = { ...form.schedule } as Record<string, unknown>
    const input = {
      name: form.name,
      schedule,
      prompt: form.prompt,
      workspaceId: form.workspaceId || undefined,
      permission: form.permission || undefined,
      provider: form.provider || undefined,
      model: form.model || undefined,
      reasoningEffort: form.reasoningEffort || undefined,
    }
    const result = await (taskId ? applyUpdateTask(taskId, input) : applyCreateTask(input))
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
  const permissionOptions = (options.permissions ?? []).length > 0
    ? options.permissions.map(option => ({ id: option.value, label: option.name }))
    : fallbackPermissions
  // 编辑旧任务：当前值不在选项里时补一项，避免显示空值。
  if (form.permission && !permissionOptions.some(option => option.id === form.permission))
    permissionOptions.unshift({ id: form.permission, label: form.permission })

  const modelValue = form.provider && form.model ? `${form.provider}::${form.model}` : ''

  return (
    <Modal
      open
      onClose={closeSafe}
      title={taskId ? t('editDialogTitle') : t('createDialogTitle')}
      description={t('dialogHint')}
      closeLabel={t('close')}
      className={K.modal}
      footer={(
        <>
          <button className={K.btn} type="button" disabled={saving} onClick={closeSafe}>{t('cancel')}</button>
          <button className={`${K.btn} ${K.btnPrimary}`} type="button" disabled={saving} onClick={() => void onSave()}>
            {t('save')}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label className={K.field}>
          <span className={K.fieldLabel}>{t('taskName')}</span>
          <input
            className={K.input}
            type="text"
            value={form.name}
            placeholder={t('taskNamePlaceholder')}
            onChange={event => setForm(state => ({ ...state, name: event.target.value }))}
          />
        </label>

        <div className={K.field}>
          <span className={K.fieldLabel}>{t('schedule')}</span>
          <div className={K.inline}>
            <select
              className={`${K.input} ${K.selectInput} ${K.inlineSelect}`}
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
                    className={`${K.input} ${K.selectInput} ${K.inlineSelectAuto}`}
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
                        className={`${K.input} ${K.selectInput} ${K.inlineSelectAuto}`}
                        value={currentWeekday}
                        aria-label={t('scheduleWeekdays')}
                        onChange={event => setSchedule({ kind: 'weekly', weekdays: [event.target.value as Weekday], time: currentTime })}
                      >
                        {WEEKDAYS.map(day => <option key={day} value={day}>{t(WEEKDAY_KEYS[day])}</option>)}
                      </select>
                      <select
                        className={`${K.input} ${K.selectInput} ${K.inlineSelectAuto}`}
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
                      className={`${K.input} ${K.selectInput} ${K.inlineSelectAuto}`}
                      value={currentTime}
                      aria-label={t('scheduleTime')}
                      onChange={event => setSchedule({ ...form.schedule, time: event.target.value } as ScheduleForm)}
                    >
                      {TIME_OPTIONS.map(time => <option key={time} value={time}>{time}</option>)}
                    </select>
                  )}
          </div>
        </div>

        <div className={K.field}>
          <span className={K.fieldLabel}>{t('schedulePrompt')}</span>
          <div className={K.promptWrap}>
            <textarea
              className={K.textarea}
              value={form.prompt}
              placeholder={t('schedulePromptPlaceholder')}
              onChange={event => setForm(state => ({ ...state, prompt: event.target.value }))}
            />
            <div className={K.composer}>
              <MenuSelect
                label={t('workspace')}
                value={form.workspaceId}
                options={workspaceOptions}
                onSelect={id => setForm(state => ({ ...state, workspaceId: id }))}
              />
              <MenuSelect
                label={t('permission')}
                value={form.permission}
                options={permissionOptions}
                onSelect={id => setForm(state => ({ ...state, permission: id }))}
              />
              <ModelPicker
                value={modelValue}
                reasoningEffort={form.reasoningEffort}
                models={options.models ?? []}
                followGlobalLabel={t('followGlobal')}
                modelLabel={t('module')}
                effortLabel={t('reasoningEffort')}
                defaultModelLabel={t('followGlobal')}
                providerDefaultLabel={t('moduleDefault')}
                onSelection={(provider, model, reasoningEffort) => setForm(state => ({
                  ...state,
                  provider,
                  model,
                  reasoningEffort,
                }))}
              />
            </div>
          </div>
        </div>
      </div>
      {error ? <p className={K.error} role="alert">{error}</p> : null}
    </Modal>
  )
}
