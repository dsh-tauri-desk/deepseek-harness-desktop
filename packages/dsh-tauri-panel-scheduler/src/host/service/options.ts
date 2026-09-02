/**
 * host/service/options.ts — 供客户端对话框/下拉使用的选项收集（工作区 / agent preset / 模型）。
 *
 * 能力探测约定：所有可选服务都「探测后调用」，缺失即返回空数组，绝不断言存在。
 * 任何读取失败都降级为空列表——选项是 UI 便利，不是能力。
 */

import type { HostContext, SchedulerOptions } from '../types/index.js'

/**
 * 收集工作区列表：遍历 workspaceRegistry 的记录（id + path）。
 * 无法枚举时返回空数组。
 */
async function collectWorkspaces(ctx: HostContext): Promise<SchedulerOptions['workspaces']> {
  try {
    const registry = ctx.workspaceRegistry
    const records = typeof registry?.list === 'function'
      ? (await registry.list()) as unknown
      : []
    if (!Array.isArray(records))
      return []
    return records
      .filter((record: unknown): record is { id?: unknown, path?: unknown, title?: unknown } =>
        typeof record === 'object' && record !== null && typeof record.id === 'string')
      .map(record => ({
        id: record.id,
        path: typeof record.path === 'string' ? record.path : record.id,
        title: typeof record.title === 'string' ? record.title : record.id,
      }))
  }
  catch {
    return []
  }
}

/** 收集 agent preset 列表（agentPresets 服务可枚举时）。 */
async function collectPresets(ctx: HostContext): Promise<SchedulerOptions['presets']> {
  try {
    const presets = ctx.get?.('agentPresets') as { list?: () => Promise<unknown> } | undefined
    if (typeof presets?.list !== 'function')
      return []
    const rows = await presets.list()
    if (!Array.isArray(rows))
      return []
    return rows
      .filter((row: unknown): row is { id?: unknown, name?: unknown } =>
        typeof row === 'object' && row !== null && typeof row.id === 'string')
      .map(row => ({
        id: row.id,
        name: typeof row.name === 'string' && row.name ? row.name : row.id,
      }))
  }
  catch {
    return []
  }
}

/** 收集默认模型（agentDefaultModel 服务存在时，作为 module 下拉的首选项）。 */
async function collectModels(ctx: HostContext): Promise<SchedulerOptions['models']> {
  try {
    const service = ctx.get?.('agentDefaultModel') as { currentSelection?: () => unknown } | undefined
    const selection = typeof service?.currentSelection === 'function'
      ? service.currentSelection() as { provider?: unknown, model?: unknown } | undefined
      : undefined
    if (!selection || typeof selection.model !== 'string' || !selection.model)
      return []
    const label = typeof selection.provider === 'string' && selection.provider
      ? `${selection.provider}/${selection.model}`
      : selection.model
    return [{ id: selection.model, label }]
  }
  catch {
    return []
  }
}

/** 收集全部选项。 */
export async function collectSchedulerOptions(ctx: HostContext): Promise<SchedulerOptions> {
  const [workspaces, presets, models] = await Promise.all([
    collectWorkspaces(ctx),
    collectPresets(ctx),
    collectModels(ctx),
  ])
  return { workspaces, presets, models }
}
