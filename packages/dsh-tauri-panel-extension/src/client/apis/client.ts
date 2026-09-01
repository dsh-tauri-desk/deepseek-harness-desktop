/**
 * apis/client.ts — 扩展面板的 RPC 客户端（ofetch 统一封装）与领域 injected 装配。
 *
 * 只做「HTTP 路径 → 类型化能力」的映射；错误信息优先取宿主 error 字段。
 * 装配产物（SkillsInjected / McpInjected）由 index.ts 注入到组件树。
 */

import type { McpInjected, McpRow, SkillRowView, SkillsInjected } from '../types'
import { createJsonClient } from 'dsh-tauri/client'
import { API_PREFIX } from '../../shared/constants'

/** ofetch 统一 JSON 客户端（错误信息优先取宿主 error 字段，与旧实现一致）。 */
const jsonApi = createJsonClient(API_PREFIX, {
  errorMessage: (status, body) => {
    const error = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : ''
    return error || `HTTP ${status}`
  },
})

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return jsonApi.request<T>(path, init)
}

function post<T>(path: string, body: unknown): Promise<T> {
  return jsonApi.post<T>(path, body)
}

export function createSkillsInjected(): SkillsInjected {
  return {
    list: () => fetchJson<{ skills: SkillRowView[] }>('/skills'),
    get: name => fetchJson(`/skill?name=${encodeURIComponent(name)}`),
    save: input => post('/skill/save', input),
    remove: name => post('/skill/delete', { name }),
    policy: (name, enabled) => post('/skill/policy', { name, enabled }),
    open: target => post('/open', target),
    importRepository: url => post('/roots/add', { kind: 'git', url }),
  }
}

export function createMcpInjected(): McpInjected {
  return {
    list: () => fetchJson<{ servers: McpRow[] }>('/mcp'),
    save: input => post('/mcp/save', input),
    toggle: (id, disabled) => post('/mcp/toggle', { id, disabled }),
    remove: id => post('/mcp/remove', { id }),
    scanImport: () => fetchJson('/import/scan'),
    applyImport: items => post('/import/apply', { items }),
    restart: async () => {
      if (window.dshDesktop !== undefined) {
        window.dshDesktop.restartSidecar?.()
        return
      }
      try {
        await post('/restart', {})
      }
      catch { /* The connection normally closes while the host restarts. */ }
    },
    desktop: typeof window !== 'undefined' && window.dshDesktop !== undefined,
  }
}
