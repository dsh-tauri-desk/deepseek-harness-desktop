/**
 * host/routes.ts — HTTP 路由装配：按业务领域把路由分派给 routes/ 下的四个模块
 * （skills / mcp / repositories / restart），统一做连接鉴权包装。
 *
 * 选型（antfu 平铺范式）：skills.ts（技能路由 + 打开目录）、mcp.ts（MCP 行 +
 * 跨目录导入）、repositories.ts（自定义技能仓库）、restart.ts（进程自重启）；
 * 每个模块导出一个 `registerXxxRoutes(register, ...)` 注册器，本文件只做组合。
 */

import type { PanelExtensionHost, RouteRegistrar } from './types.ts'
import { withConnectionAuth } from 'dsh-tauri'
import { PLUGIN_NAME } from '../shared/constants.ts'
import { registerMcpRoutes } from './routes/mcp.ts'
import { registerRepositoryRoutes } from './routes/repositories.ts'
import { registerRestartRoute } from './routes/restart.ts'
import { registerSkillRoutes } from './routes/skills.ts'

export interface PanelExtensionRoutesConfig {
  profileDirPath: string
  /** Remount the host-plane skill provider after root-set changes. */
  remountProvider: () => Promise<void>
}

/** Register the manager's routes; returns the disposer removing them all. */
export function mountPanelExtensionRoutes(host: PanelExtensionHost, config: PanelExtensionRoutesConfig): () => void {
  const register: RouteRegistrar = route => host.webServer.register({
    ...route,
    handler: withConnectionAuth(host.connection, route.handler, PLUGIN_NAME),
  })

  const disposers = [
    ...registerSkillRoutes(register, host),
    ...registerMcpRoutes(register, { profileDirPath: config.profileDirPath }),
    ...registerRepositoryRoutes(register, { remountProvider: config.remountProvider }),
    ...registerRestartRoute(register),
  ]

  return () => {
    for (const dispose of disposers)
      dispose()
  }
}
