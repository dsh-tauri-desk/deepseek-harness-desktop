/**
 * host/service/permission-presets.ts — Host 官方权限预设服务的最小结构契约。
 *  对齐 MichengAI/dsh-automation 的 src/permission-presets.ts。
 */

export interface PermissionOption {
  readonly value: string
  readonly name: string
  readonly description?: string
}

export interface PermissionPresetService {
  readonly names: readonly string[]
  readonly defaultPreset: string
  optionOf: (name: string) => PermissionOption
  set: (session: unknown, name: string) => void
}

/** 兼容旧版插件曾保存的 full-access 名称，其余值必须来自 Host 当前列表。 */
export function normalizePermissionPreset(
  input: unknown,
  names: readonly string[],
): string | undefined {
  if (typeof input !== 'string')
    return undefined
  const raw = input.trim()
  if (raw === '')
    return undefined
  const value = raw === 'full-access' ? 'danger-full-access' : raw
  return names.includes(value) ? value : undefined
}
