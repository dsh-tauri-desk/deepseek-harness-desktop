import type { ExtensionClientContext, McpInjected, McpRow, SkillRowView, SkillsInjected, Translate } from './types'
import { compat } from 'dsh-tauri/client'
import { API_PREFIX, LOCALE_NAMESPACE, PLUGIN_ID } from './constants'
import { installExtensionPanel, registerSkillCreatorPrefill } from './extension-panel'
import { installExtensionLocale } from './locale'
import { mountExtensionStyles } from './styles'

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, init)
  const body = await response.json() as T & { error?: string }
  if (!response.ok)
    throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

function post<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function createSkillsInjected(): SkillsInjected {
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

function createMcpInjected(): McpInjected {
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

export const name = PLUGIN_ID
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

export function apply(ctx: ExtensionClientContext): void {
  const cx = compat(ctx)
  installExtensionLocale(ctx)
  ctx.effect(() => mountExtensionStyles(), `${PLUGIN_ID}: styles`)
  const t = ctx.locale.bind(LOCALE_NAMESPACE) as Translate
  registerSkillCreatorPrefill(ctx)
  installExtensionPanel(cx as ExtensionClientContext, t, createSkillsInjected(), createMcpInjected())
}
