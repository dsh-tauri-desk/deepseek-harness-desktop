import { task } from '../service/task'
import { textBlock } from '../utils/tool'

export function toggleTaskTool(): any {
  return {
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
      const result = await task.toggle(String(args.task_id ?? ''), args.enabled === true)
      if (!result.ok)
        return { ok: false, error: result.error }
      return { ok: true, enabled: result.task.enabled }
    },
  }
}
