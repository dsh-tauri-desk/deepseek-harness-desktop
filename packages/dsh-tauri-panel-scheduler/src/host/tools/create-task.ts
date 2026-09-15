import { SCHEDULE_KINDS } from '../../shared/constants'
import { task } from '../service/task'
import { textBlock } from '../utils/tool'

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    taskId: { type: 'string' },
    nextRunAt: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['ok'],
}

export function createTaskTool(): any {
  return {
    name: 'scheduler_create',
    description:
      'Create a scheduled task that runs a prompt automatically on a schedule. '
      + 'Use when the user asks to set up a daily, weekly, workday, or interval automation '
      + '(e.g. "write a daily report every weekday at 9am"). The task runs in a fresh session.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name, e.g. "Daily report".' },
        prompt: { type: 'string', description: 'The task instruction run in the scheduled session.' },
        schedule: {
          type: 'object',
          description: 'Schedule spec: once/hourly/daily/interval/workdays/weekly/monthly/custom.',
          properties: {
            kind: { type: 'string', enum: [...SCHEDULE_KINDS] },
            time: { type: 'string', description: '"HH:mm" for daily/workdays/weekly.' },
            everyMinutes: { type: 'number', description: 'Interval minutes for kind=interval.' },
            everyDays: { type: 'number', description: 'Interval days for kind=custom.' },
            anchor: { type: 'string', description: 'ISO anchor for fixed interval/custom recurrence.' },
            at: { type: 'string', description: 'ISO timestamp for kind=once.' },
            minute: { type: 'number', description: 'Minute of hour for kind=hourly.' },
            day: { type: 'number', description: 'Day of month for kind=monthly.' },
            weekdays: { type: 'array', items: { type: 'string' }, description: '["MO","TU",...] for kind=weekly.' },
          },
          required: ['kind'],
        },
        workspaceId: { type: 'string', description: 'Optional target workspace id (cwd).' },
        permission: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Permission boundary (read-only / workspace-write / danger-full-access). Default read-only.' },
        provider: { type: 'string', description: 'Optional pinned model provider id (pair with model).' },
        model: { type: 'string', description: 'Optional pinned model id (pair with provider).' },
        reasoningEffort: { type: 'string', description: 'Optional pinned reasoning effort id for the selected model.' },
      },
      required: ['name', 'prompt', 'schedule'],
    },
    output: {
      schema: outputSchema,
      render: (_args: unknown, value: any) => value.ok
        ? textBlock(`✅ 定时任务已创建：${value.taskId}（下次运行 ${value.nextRunAt ?? '待计算'}）`)
        : textBlock(`❌ 创建定时任务失败：${value.error}`),
    },
    async execute(args: any) {
      const result = await task.create({
        name: String(args.name ?? ''),
        prompt: String(args.prompt ?? ''),
        schedule: args.schedule,
        workspaceId: args.workspaceId === undefined ? undefined : String(args.workspaceId),
        permission: args.permission === undefined ? undefined : String(args.permission),
        provider: args.provider === undefined ? undefined : String(args.provider),
        model: args.model === undefined ? undefined : String(args.model),
        reasoningEffort: args.reasoningEffort === undefined ? undefined : String(args.reasoningEffort),
      })
      if (!result.ok)
        return { ok: false, error: result.error }
      return { ok: true, taskId: result.task.id, nextRunAt: result.task.nextRunAt ?? null }
    },
  }
}
