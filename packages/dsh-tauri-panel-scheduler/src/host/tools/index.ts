/**
 * host/tools/index.ts — Agent 自发调用的定时任务工具集。
 *
 * 与 DSH automation 工具语义对齐：scheduler_create / scheduler_list /
 * scheduler_toggle / scheduler_delete / scheduler_run_now，让用户在会话里就能
 * 创建/管理定时任务（「通过 Chat 创建」入口）。
 */

import type { SchedulerEngine } from '../service/scheduler.js'
import { createTask, deleteTask, listTasks, setTaskEnabled } from '../service/manager.js'

/** 文本渲染助手。 */
function textBlock(text: string): Array<{ type: 'text', text: string }> {
  return [{ type: 'text', text }]
}

/** 组装定时任务工具集。 */
export function createToolSet(engine: SchedulerEngine): any[] {
  return [
    {
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
            description: 'Schedule spec: { kind: "daily"|"interval"|"workdays"|"weekly", ... }.',
            properties: {
              kind: { type: 'string', enum: ['daily', 'interval', 'workdays', 'weekly'] },
              time: { type: 'string', description: '"HH:mm" for daily/workdays/weekly.' },
              everyMinutes: { type: 'number', description: 'Interval minutes for kind=interval.' },
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
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            taskId: { type: 'string' },
            nextRunAt: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args: unknown, value: any) => value.ok
          ? textBlock(`✅ 定时任务已创建：${value.taskId}（下次运行 ${value.nextRunAt ?? '待计算'}）`)
          : textBlock(`❌ 创建定时任务失败：${value.error}`),
      },
      async execute(args: any) {
        const result = await createTask({
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
    },
    {
      name: 'scheduler_list',
      description: 'List all scheduled tasks with their next run time and enabled state.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, tasks: { type: 'array' } }, required: ['ok'] },
        render: (_args: unknown, value: any) => {
          if (!value.ok)
            return textBlock(`❌ 获取定时任务失败：${value.error}`)
          const rows = (value.tasks as any[] ?? []).map((task: any) =>
            `- ${task.enabled ? '🟢' : '⏸️'} ${task.name} (${task.id}) next=${task.nextRunAt ?? '-'}`)
          return textBlock(rows.length ? `当前定时任务：\n${rows.join('\n')}` : '当前没有定时任务。')
        },
      },
      async execute() {
        return { ok: true, tasks: listTasks() }
      },
    },
    {
      name: 'scheduler_toggle',
      description: 'Pause or resume a scheduled task by id.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task id.' },
          enabled: { type: 'boolean', description: 'true to resume, false to pause.' },
        },
        required: ['task_id', 'enabled'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, error: { type: 'string' } }, required: ['ok'] },
        render: (_args: unknown, value: any) => value.ok
          ? textBlock(`✅ 已${value.enabled ? '恢复' : '暂停'}定时任务。`)
          : textBlock(`❌ 操作失败：${value.error}`),
      },
      async execute(args: any) {
        const result = await setTaskEnabled(String(args.task_id ?? ''), args.enabled === true)
        if (!result.ok)
          return { ok: false, error: result.error }
        return { ok: true, enabled: result.task.enabled }
      },
    },
    {
      name: 'scheduler_delete',
      description: 'Delete a scheduled task by id (keeps run history).',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task id.' } },
        required: ['task_id'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, error: { type: 'string' } }, required: ['ok'] },
        render: (_args: unknown, value: any) => value.ok ? textBlock('✅ 已删除定时任务。') : textBlock(`❌ 删除失败：${value.error}`),
      },
      async execute(args: any) {
        const result = await deleteTask(String(args.task_id ?? ''))
        if (!result.ok)
          return { ok: false, error: result.error }
        return { ok: true }
      },
    },
    {
      name: 'scheduler_run_now',
      description: 'Immediately run a scheduled task by id (manual trigger).',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task id.' } },
        required: ['task_id'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, error: { type: 'string' } }, required: ['ok'] },
        render: (_args: unknown, value: any) => value.ok ? textBlock('✅ 已触发立即运行。') : textBlock(`❌ 触发失败：${value.error}`),
      },
      async execute(args: any) {
        const result = await engine.runNow(String(args.task_id ?? ''))
        if (!result.ok)
          return { ok: false, error: result.error }
        return { ok: true }
      },
    },
  ]
}
