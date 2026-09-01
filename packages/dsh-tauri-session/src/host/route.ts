/**
 * route.ts — 归档管理 HTTP 路由（/api/dsh-session/*）：archived / archive /
 * archive-workspace / unarchive / delete / delete-workspace / clear。
 *
 * 变更类路由标注 mutate: true，统一由 withConnectionAuth 做连接鉴权；
 * 每个 handler 只是把 body 参数化后转交 archive.ts 的业务函数，不内联业务逻辑。
 */

import type { HostContext } from './types.js'
import { routeHandler, withConnectionAuth } from 'dsh-tauri'
import { SESSION_API_PREFIX, SESSION_PLUGIN_NAME } from '../shared/constants.js'
import {
  archiveSession,
  archiveWorkspace,
  buildArchivedPayload,
  permanentlyDeleteAll,
  permanentlyDeleteSelected,
  permanentlyDeleteSession,
  unarchiveSession,
} from './archive.js'

/** 构建路由列表。 */
export function buildRoutes(ctx: HostContext, dshHome: string): any[] {
  const routes = [
    {
      kind: 'exact',
      path: `${SESSION_API_PREFIX}/archived`,
      handler: routeHandler(async () => [200, buildArchivedPayload(ctx)]),
    },
    {
      kind: 'exact',
      path: `${SESSION_API_PREFIX}/archive`,
      handler: routeHandler(async body => [200, await archiveSession(ctx, body)], { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SESSION_API_PREFIX}/archive-workspace`,
      handler: routeHandler(async body => [200, await archiveWorkspace(ctx, body)], { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SESSION_API_PREFIX}/unarchive`,
      handler: routeHandler(async body => [200, await unarchiveSession(ctx, body)], { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SESSION_API_PREFIX}/delete`,
      handler: routeHandler(async body => [200, await permanentlyDeleteSession(ctx, dshHome, body)], { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SESSION_API_PREFIX}/delete-workspace`,
      handler: routeHandler(async body => [200, await permanentlyDeleteSelected(ctx, dshHome, body)], { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SESSION_API_PREFIX}/clear`,
      handler: routeHandler(async () => [200, await permanentlyDeleteAll(ctx, dshHome)], { mutate: true }),
    },
  ]
  return routes.map(route => ({
    ...route,
    handler: withConnectionAuth(ctx.connection, route.handler, SESSION_PLUGIN_NAME),
  }))
}
