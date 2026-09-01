/**
 * host/hooks.ts — 宿主 filesystem skill provider 的生命周期钩子（hookable）。
 *
 * remountProvider（根集变更 → 卸载旧 fiber + 挂载新 fiber）是真实的状态机轴；
 * 前后/错误钩子让诊断与联动（日志、统计、第三方行为）不侵入 apply 本体。
 */

import { createHooks } from 'hookable'

/** provider 重挂载对外可扩展的生命周期钩子。 */
export interface ProviderLifecycleHooks {
  /** 根集变更、重挂载开始前（旧 fiber 尚未卸载）。 */
  'provider:before-remount': () => void
  /** 重挂载完成后（roots 为本次挂载的扫描根集合）。 */
  'provider:after-remount': (roots: string[]) => void
  /** 挂载失败（错误对象；路由继续可用，provider 降级为空目录）。 */
  'provider:error': (error: unknown) => void
}

function createProviderHooks() {
  return createHooks<ProviderLifecycleHooks>()
}

/** provider 钩子注册表（插件级单例；未注册的钩子名调用是空操作）。 */
export const providerHooks = createProviderHooks()
