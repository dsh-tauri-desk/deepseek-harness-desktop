import { scheduler } from '../service/scheduler'
import { textBlock } from '../utils/tool'

export function runTaskTool(): any {
  return {
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
      const result = await scheduler.trigger(String(args.task_id ?? ''))
      if (!result.ok)
        return { ok: false, error: result.error }
      return { ok: true }
    },
  }
}
