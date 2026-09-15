import type { YAMLMap } from 'yaml'
import type { McpCheckOptions, McpCheckResult, McpInput, McpListResult, McpRow, McpRowView } from './mcp.types'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { defineService, DSH_HOME } from 'dsh-tauri'
import { compact, isEmpty } from 'lodash-es'
import { join } from 'pathe'
import { MCP_CHECK_TIMEOUT_MS, MCP_PLUGIN, PATCH_FILE_NAME } from '../config/constants'
import {
  insertListOf,
  loadPatch,
  managedInsert,
  mcpRowItems,
  readRows,
  rowSeq,
  savePatch,
  takenIds,
  toNode,
} from './mcp.utils'

export const mcp = defineService({
  list(profileDirPath: string): McpListResult {
    let globalRows: McpRow[] = []
    let globalError: string | undefined
    if (existsSync(join(DSH_HOME, PATCH_FILE_NAME))) {
      try {
        globalRows = readRows(DSH_HOME)
      }
      catch (error) {
        globalError = error instanceof Error ? error.message : String(error)
      }
    }
    const globalIds = new Set(compact(globalRows.map(row => row.id)))
    return {
      servers: [
        ...globalRows.map((row): McpRowView => ({ ...row, scope: 'global' })),
        ...readRows(profileDirPath).map((row): McpRowView => ({
          ...row,
          scope: 'profile',
          ...(globalIds.has(row.id) ? { shadowed: true } : {}),
        })),
      ],
      ...(globalError !== undefined ? { globalError } : {}),
    }
  },

  peek(dirPath: string): McpRow[] {
    return readRows(dirPath)
  },

  save(dirPath: string, input: McpInput): string {
    const inputId = input.id ?? ''
    const doc = loadPatch(dirPath)
    const list = managedInsert(doc)
    const existing = inputId !== ''
      ? mcpRowItems(doc).find(({ node }) => String(node.get('id') ?? '') === inputId)
      : undefined

    let id = inputId !== '' ? inputId : `mcp-${input.serverName}`
    if (existing === undefined) {
      const taken = takenIds(doc)
      let suffix = 2
      while (taken.has(id))
        id = `mcp-${input.serverName}-${suffix++}`
    }

    const config: Record<string, unknown> = input.transport === 'stdio'
      ? {
          serverName: input.serverName,
          transport: input.transport,
          command: input.command,
          ...(!isEmpty(input.args) ? { args: input.args } : {}),
          ...(!isEmpty(input.env) ? { env: input.env } : {}),
          ...(!isEmpty(input.cwd) ? { cwd: input.cwd } : {}),
        }
      : {
          serverName: input.serverName,
          transport: input.transport,
          url: input.url,
          ...(!isEmpty(input.headers) ? { headers: input.headers } : {}),
        }
    const row: Record<string, unknown> = { id, name: MCP_PLUGIN, config }
    if (input.disabled === true)
      row.disabled = true

    const node = toNode<YAMLMap>(row)
    if (existing === undefined) {
      list.add(node)
    }
    else if (existing.list !== undefined) {
      existing.list.items.splice(existing.list.items.indexOf(existing.node), 1, node)
    }
    else {
      rowSeq(doc).items.splice(rowSeq(doc).items.indexOf(existing.node), 1, node)
    }

    savePatch(dirPath, doc)
    return id
  },

  remove(dirPath: string, id: string): boolean {
    const doc = loadPatch(dirPath)
    managedInsert(doc)
    const hit = mcpRowItems(doc).find(({ node }) => String(node.get('id') ?? '') === id)
    if (hit === undefined || hit.list === undefined)
      return false
    hit.list.items.splice(hit.list.items.indexOf(hit.node), 1)

    const seq = rowSeq(doc)
    const owner = (seq.items ?? []).find(item => insertListOf(item) === hit.list)
    if (owner !== undefined && hit.list.items.length === 0 && owner.items.length === 1)
      seq.items.splice(seq.items.indexOf(owner), 1)

    savePatch(dirPath, doc)
    return true
  },

  async check(row: McpRow, options: McpCheckOptions = {}): Promise<McpCheckResult> {
    const pathEnv = options.pathEnv ?? process.env.PATH ?? ''
    if (row.transport === 'stdio') {
      const command = row.command ?? ''
      if (command === '')
        return { ok: false, detail: 'row has no command' }
      return resolveCommandOnPath(command, pathEnv, options.platform)
        ? { ok: true, detail: command }
        : { ok: false, detail: `${command} not found on PATH` }
    }
    if (row.url === undefined || !/^https?:\/\//.test(row.url))
      return { ok: false, detail: 'row has no http url' }
    try {
      const response = await fetch(row.url, {
        headers: { accept: 'application/json, text/event-stream' },
        signal: AbortSignal.timeout(options.timeoutMs ?? MCP_CHECK_TIMEOUT_MS),
      })
      return { ok: true, detail: `HTTP ${response.status}` }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cause = (error as { cause?: { code?: unknown } }).cause?.code
      return { ok: false, detail: cause !== undefined ? String(cause) : message }
    }
  },
})

// --- internal ---

function resolveCommandOnPath(command: string, pathEnv: string, platform: string = process.platform): boolean {
  if (command.includes('/') || command.includes('\\'))
    return existsSync(command)
  const exts = platform === 'win32' ? ['', '.com', '.exe', '.bat', '.cmd'] : ['']
  const separator = platform === 'win32' ? ';' : ':'
  for (const rawDir of pathEnv.split(separator)) {
    const dir = rawDir.trim().replace(/^"|"$/g, '')
    if (dir === '')
      continue
    for (const ext of exts) {
      if (existsSync(join(dir, command + ext)))
        return true
    }
  }
  return false
}
