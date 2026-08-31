/**
 * registry.ts — 全局扩展注册表：其他 Web 插件经
 * `globalThis[Symbol.for('dsh.rightclick-menu.extensions')]` 登记/查询扩展项。
 *
 * 注册表是插件间协议（不随 bundle 重载而失效），所以挂在 Symbol.for 全局键上，
 * 并用租约计数（LEASE）保证「插件实例持有期间不清理全局注册表」：apply 时 +1，
 * dispose 时 -1，全部释放且无条目时才删除全局键。
 */
import type { ContextMenuExtension } from './types'
import { EXTENSIONS_LEASE_KEY, EXTENSIONS_REGISTRY_KEY } from './constants'

const KEY = Symbol.for(EXTENSIONS_REGISTRY_KEY)
const LEASE = Symbol.for(EXTENSIONS_LEASE_KEY)

/** 全局注册表载体（Symbol 键索引，避免给 globalThis 补任意索引签名）。 */
const globalStore = globalThis as typeof globalThis & Record<symbol, unknown>

export interface ExtensionRegistryApi {
  /** 登记一条扩展项；返回 disposer（卸载时调用，条目删除且无租约时回收全局注册表）。 */
  register: (entry: ContextMenuExtension) => () => void
  /** 按 order 升序的当前扩展项列表。 */
  list: () => ContextMenuExtension[]
  /** 租约计数（仅插件 apply/dispose 使用）。 */
  [LEASE]: (delta: number) => void
}

/** 取得（或首次创建）全局扩展注册表。 */
export function registry(): ExtensionRegistryApi {
  const existing = globalStore[KEY] as ExtensionRegistryApi | undefined
  if (existing)
    return existing
  const entries = new Map<string, ContextMenuExtension>()
  let leases = 0
  const api: ExtensionRegistryApi = {
    register(entry) {
      if (!entry?.id || entries.has(entry.id))
        throw new Error('invalid or duplicate context-menu extension')
      entries.set(entry.id, entry)
      return () => {
        entries.delete(entry.id)
        if (!leases && !entries.size && globalStore[KEY] === api)
          delete globalStore[KEY]
      }
    },
    list() {
      return [...entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    },
    [LEASE](delta) {
      leases += delta
      if (!leases && !entries.size && globalStore[KEY] === api)
        delete globalStore[KEY]
    },
  }
  globalStore[KEY] = Object.freeze(api)
  return api
}

/** 插件 apply 时持有租约、dispose 时释放。 */
export function holdRegistryLease(): () => void {
  const api = registry()
  api[LEASE](1)
  return () => {
    if (globalStore[KEY] === api)
      api[LEASE](-1)
  }
}
