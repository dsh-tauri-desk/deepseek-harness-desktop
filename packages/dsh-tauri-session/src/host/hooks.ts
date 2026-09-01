/**
 * host/hooks.ts — 归档状态变更钩子（hookable）。
 *
 * archive.ts 的业务操作在状态落定后发事件；其他插件可 hook 同一轴做联动
 * （例如桌面端清理缓存、统计），不改插件本体。
 */

import { createHooks } from 'hookable'

/** 归档管理对外可扩展的生命周期钩子。 */
export interface ArchiveLifecycleHooks {
  /** 会话被加入归档集合（逐个触发，批量归档循环内各发一次）。 */
  'archive:added': (sessionId: string) => void
  /** 会话被取消归档。 */
  'archive:restored': (sessionId: string) => void
  /** 一批归档会话被彻底删除（注册表事务完成后触发）。 */
  'archive:deleted': (sessionIds: readonly string[]) => void
}

/** 归档钩子注册表（插件级单例；未注册的钩子名调用是空操作）。 */
function createArchiveHooks() {
  return createHooks<ArchiveLifecycleHooks>()
}

export const archiveHooks = createArchiveHooks()
