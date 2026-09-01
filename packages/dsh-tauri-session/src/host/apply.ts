/**
 * host/apply.ts — 归档插件装配：旧版归档迁移 + HTTP 路由注册。
 * 迁移/路由均挂 effect（插件卸载即清理）；归档状态钩子（archive:added 等）
 * 由 archive.ts 在业务操作内触发，见 host/hooks.ts。
 */

import type { HostContext, PluginConfig } from './types.js'
import { homedir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { SESSION_PLUGIN_NAME } from '../shared/constants.js'
import { migrateLegacyArchive } from './archive.js'
import { buildRoutes } from './route.js'

function resolveDshHome(config: PluginConfig): string {
  return typeof config.dshHome === 'string' && config.dshHome ? config.dshHome : process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * 插件体：迁移旧版归档 + 注册 HTTP 路由。
 * @param ctx - 宿主根上下文（注入 webServer/sessions/workspaceRegistry）。
 * @param config - 插件行配置（dshHome 等，仅用于旧版归档迁移路径）。
 */
export function apply(ctx: HostContext, config: PluginConfig = {}): void {
  const cfg = config ?? {}
  const dshHome = resolveDshHome(cfg)

  // 旧版自持归档一次性迁入宿主集合（幂等：文件不存在或为空则直接跳过）。
  ctx.effect(() => {
    void migrateLegacyArchive(ctx, dshHome)
  }, `${SESSION_PLUGIN_NAME}: migrate legacy archive`)

  // HTTP 路由注册（客户端经此调用 archived/archive/unarchive/delete/clear）。
  ctx.effect(() => {
    const disposers = buildRoutes(ctx, dshHome).map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers)
        dispose()
    }
  }, `${SESSION_PLUGIN_NAME}: routes`)
}
