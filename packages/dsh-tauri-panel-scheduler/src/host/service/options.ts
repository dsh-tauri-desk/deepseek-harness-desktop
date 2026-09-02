/**
 * host/service/options.ts — 供客户端对话框/下拉使用的选项收集（工作区 / 权限 / 模型目录）。
 *
 * 对齐 dsh-automation（MichengAI）：
 *   - 权限选项来自宿主 `ctx.permissionPresets` 服务（names / optionOf / defaultPreset），
 *     不硬编码——宿主动态提供 read-only / workspace-write / danger-full-access 等；
 *   - 模型目录用 `ctx.llm.listProviders()/listModels()/resolveModelInfo()` 枚举（含 reasoning
 *     efforts / defaultEffort），`ctx.agentDefaultModel.currentSelection()` 定默认模型。
 * 能力探测约定：所有可选服务「探测后调用」，缺失即返回空，绝不断言存在。
 */

import type { HostContext, ModelOption, PermissionOption, SchedulerOptions } from '../types/index.js'

/** 收集工作区列表：遍历 workspaceRegistry 的记录（id + path）。无法枚举时返回空数组。 */
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

/** 收集权限选项与默认权限（宿主 permissionPresets 服务；缺失降级）。 */
function collectPermissions(ctx: HostContext): { permissions: PermissionOption[], defaultPermission: string } {
  try {
    const presets = (ctx as HostContext & {
      permissionPresets?: {
        names?: readonly string[]
        defaultPreset?: string
        optionOf?: (name: string) => PermissionOption
      }
    }).permissionPresets
    const names = Array.isArray(presets?.names) ? presets.names : []
    if (names.length === 0)
      return { permissions: [], defaultPermission: 'read-only' }
    const permissions = names.map(name => presets.optionOf?.(name) ?? { value: name, name })
    const defaultPermission = typeof presets?.defaultPreset === 'string' && presets.defaultPreset
      ? presets.defaultPreset
      : (names[0] ?? 'read-only')
    return { permissions, defaultPermission }
  }
  catch {
    return { permissions: [], defaultPermission: 'read-only' }
  }
}

interface LlmLike {
  listProviders?: () => readonly { id?: string, provider?: string, name?: string }[]
  listModels?: (provider: string) => Promise<readonly { id?: string, name?: string, description?: string }[]>
  resolveModelInfo?: (provider: string, model: string) => Promise<{
    description?: string
    reasoning?: {
      efforts: readonly { id: string, name: string, description?: string }[]
      defaultEffort?: string
    }
  }>
}

/** 收集模型目录（flat，含 reasoning），并返回与当前默认匹配的 defaultModel。 */
async function collectModels(ctx: HostContext): Promise<{ models: ModelOption[], defaultModel: ModelOption | null }> {
  try {
    const current = ((ctx as HostContext).get?.('agentDefaultModel') as { currentSelection?: () => unknown } | undefined)?.currentSelection?.() as
      { provider?: unknown, model?: unknown } | undefined
    const llm = (ctx as HostContext).get?.('llm') as LlmLike | undefined
    const found: ModelOption[] = []
    const seen = new Set<string>()
    for (const item of llm?.listProviders?.() ?? []) {
      const provider = String(item.id ?? item.provider ?? '')
      if (provider === '')
        continue
      const providerLabel = String(item.name ?? provider)
      try {
        const models = await llm?.listModels?.(provider) ?? []
        for (const model of models) {
          const modelId = String(model.id ?? '')
          if (modelId === '')
            continue
          const key = `${provider}::${modelId}`
          if (seen.has(key))
            continue
          seen.add(key)
          const resolved = llm?.resolveModelInfo === undefined
            ? undefined
            : await llm.resolveModelInfo(provider, modelId)
          const reasoning = resolved?.reasoning === undefined
            ? undefined
            : {
                efforts: resolved.reasoning.efforts.map(effort => ({
                  id: String(effort.id),
                  name: String(effort.name),
                  ...(effort.description === undefined ? {} : { description: String(effort.description) }),
                })),
                ...(resolved.reasoning.defaultEffort === undefined
                  ? {}
                  : { defaultEffort: String(resolved.reasoning.defaultEffort) }),
              }
          found.push({
            provider,
            providerLabel,
            model: modelId,
            label: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : modelId,
            ...((resolved?.description ?? model.description) === undefined
              ? {}
              : { description: String(resolved?.description ?? model.description) }),
            ...(reasoning === undefined ? {} : { reasoning }),
          })
        }
      }
      catch {
        /* 单个 provider 失败忽略 */
      }
    }
    const defaultModel = current === null
      ? (found[0] ?? null)
      : (found.find(item => item.provider === current.provider && item.model === current.model) ?? found[0] ?? null)
    return { models: found, defaultModel }
  }
  catch {
    return { models: [], defaultModel: null }
  }
}

/** 收集全部选项。 */
export async function collectSchedulerOptions(ctx: HostContext): Promise<SchedulerOptions> {
  const [workspaces, permission, modelCatalog] = await Promise.all([
    collectWorkspaces(ctx),
    Promise.resolve(collectPermissions(ctx)),
    collectModels(ctx),
  ])
  return {
    workspaces,
    permissions: permission.permissions,
    defaultPermission: permission.defaultPermission,
    models: modelCatalog.models,
    defaultModel: modelCatalog.defaultModel,
  }
}
