/**
 * routes/repositories.ts — 自定义技能仓库 HTTP 路由（roots 列表 / 添加 / 移除）。
 *
 * 仓库的本地/GitHub 物料在 ../repos.ts，持久化与移除在 ../state.ts。添加/移除
 * 后必须先 remountProvider（宿主侧的 filesystem skill provider 持有目录 watcher，
 * Windows 上移除被 watch 的树会 EPERM），再删除物料目录。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SkillRootEntry } from '../state.ts'
import type { RouteRegistrar } from '../types.ts'
import { readJsonBody, sameOrigin, sendJson } from 'dsh-tauri'
import { API_PREFIX } from '../../shared/constants.ts'
import { addGitRepo, addLocalRepo, rootExists } from '../repos.ts'
import { removeTree } from '../rmtree.ts'
import { loadState, removeSkillRoot } from '../state.ts'

/** One registered repository plus a liveness flag (roots can go stale). */
function toRootView(entry: SkillRootEntry): SkillRootEntry & { live: boolean } {
  return { ...entry, live: entry.roots.every(root => rootExists(root)) }
}

/** Repository route module 的配置片：仓库变更后重挂宿主 provider。 */
export interface RepositoryRoutesConfig {
  remountProvider: () => Promise<void>
}

export function registerRepositoryRoutes(
  register: RouteRegistrar,
  config: RepositoryRoutesConfig,
): Array<() => void> {
  const disposers: Array<() => void> = []

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/roots`,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      sendJson(response, 200, { roots: loadState().skillRoots.map(toRootView) })
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/roots/add`,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      try {
        const body = (await readJsonBody(request)) as { kind?: unknown, path?: unknown, url?: unknown }
        if (body.kind !== 'local' && body.kind !== 'git') {
          sendJson(response, 400, { error: 'kind must be local or git' })
          return
        }
        const entry = body.kind === 'local'
          ? typeof body.path === 'string' && body.path.trim() !== ''
            ? await addLocalRepo(body.path)
            : undefined
          : typeof body.url === 'string' && body.url.trim() !== ''
            ? await addGitRepo(body.url)
            : undefined
        if (entry === undefined) {
          sendJson(response, 400, { error: body.kind === 'local' ? 'path is required' : 'url is required' })
          return
        }
        await config.remountProvider()
        sendJson(response, 200, { ok: true, root: toRootView(entry) })
      }
      catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/roots/remove`,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      try {
        const body = (await readJsonBody(request)) as { id?: unknown }
        if (typeof body.id !== 'string') {
          sendJson(response, 400, { error: 'id is required' })
          return
        }
        const removed = await removeSkillRoot(body.id)
        if (removed === undefined) {
          sendJson(response, 404, { error: 'repository not found' })
          return
        }
        // Unwatch before unlink: the provider's directory watchers hold
        // handles on the material tree, and removing a watched tree on
        // Windows fails with EPERM (the state is already saved by then,
        // which is why the repo still disappears despite the error).
        await config.remountProvider()
        if (removed.materialDir !== undefined)
          removeTree(removed.materialDir)
        sendJson(response, 200, { ok: true })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  return disposers
}
