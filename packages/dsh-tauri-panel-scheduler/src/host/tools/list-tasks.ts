import { tasks } from '../service/tasks'
import { textBlock } from '../utils/tool'

export function listTasksTool(): any {
  return {
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
      return { ok: true, tasks: await tasks.list() }
    },
  }
}
