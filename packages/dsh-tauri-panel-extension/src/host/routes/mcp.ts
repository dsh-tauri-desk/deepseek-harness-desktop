/**
 * routes/mcp.ts — MCP 服务器行 HTTP 路由（mcp 列表/保存/开关/移除 + 导入扫描/应用）。
 *
 * 只做参数化与转发：cordis.patch.yml 的读写在 ../mcp.ts，跨目录导入扫描在
 * ../agents.ts。所有返回 `restartNeeded: true`，因为行变更需要 dsh 重启才能组合。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpInput } from '../mcp.ts'
import type { RouteRegistrar } from '../types.ts'
import { readJsonBody, sameOrigin, sendJson } from 'dsh-tauri'
import { API_PREFIX } from '../../shared/constants.ts'
import { scanAllMcp } from '../agents.ts'
import { listMcp, removeMcp, setMcpDisabled, upsertMcp, validateMcpInput } from '../mcp.ts'

/** MCP route module 的配置片：profile patch 目录。 */
export interface McpRoutesConfig {
  profileDirPath: string
}

export function registerMcpRoutes(
  register: RouteRegistrar,
  config: McpRoutesConfig,
): Array<() => void> {
  const disposers: Array<() => void> = []

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/mcp`,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      sendJson(response, 200, { servers: listMcp(config.profileDirPath), restartNeeded: true })
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/mcp/save`,
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
        const input = (await readJsonBody(request)) as McpInput
        const invalid = validateMcpInput(input)
        if (invalid !== null) {
          sendJson(response, 400, { error: invalid })
          return
        }
        const id = upsertMcp(config.profileDirPath, input)
        sendJson(response, 200, { ok: true, id, restartNeeded: true })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/mcp/toggle`,
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
        const body = (await readJsonBody(request)) as { id?: unknown, disabled?: unknown }
        if (typeof body.id !== 'string' || typeof body.disabled !== 'boolean') {
          sendJson(response, 400, { error: 'id and disabled are required' })
          return
        }
        const ok = setMcpDisabled(config.profileDirPath, body.id, body.disabled)
        sendJson(response, ok ? 200 : 404, ok ? { ok: true, restartNeeded: true } : { error: 'server row not found' })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/mcp/remove`,
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
        const ok = removeMcp(config.profileDirPath, body.id)
        sendJson(response, ok ? 200 : 404, ok ? { ok: true, restartNeeded: true } : { error: 'server row not found' })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/import/scan`,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        sendJson(response, 200, {
          servers: scanAllMcp(),
          // Profile serverNames, so the browser can grey out existing ones.
          existing: listMcp(config.profileDirPath).map(row => row.serverName),
        })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/import/apply`,
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
        const body = (await readJsonBody(request)) as { items?: unknown }
        const wanted = new Set(
          (Array.isArray(body.items) ? body.items : [])
            .filter((item): item is { agent: string, name: string } =>
              typeof item === 'object' && item !== null && typeof (item as { agent?: unknown }).agent === 'string' && typeof (item as { name?: unknown }).name === 'string')
            .map(item => `${item.agent}/${item.name}`),
        )
        const results: Array<{ name: string, ok: boolean, error?: string }> = []
        for (const server of scanAllMcp()) {
          if (!wanted.has(`${server.agent}/${server.name}`))
            continue
          const existing = listMcp(config.profileDirPath).some(row => row.serverName === server.name)
          if (existing) {
            results.push({ name: server.name, ok: false, error: 'already in profile' })
            continue
          }
          const input: McpInput = {
            id: '',
            serverName: server.name,
            transport: server.transport,
            ...(server.transport === 'stdio'
              ? { command: server.command, args: server.args, env: server.env }
              : { url: server.url, headers: server.headers }),
          }
          const invalid = validateMcpInput(input)
          if (invalid !== null) {
            results.push({ name: server.name, ok: false, error: invalid })
            continue
          }
          upsertMcp(config.profileDirPath, input)
          results.push({ name: server.name, ok: true })
        }
        sendJson(response, 200, { ok: results.every(item => item.ok), results, restartNeeded: true })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  return disposers
}
