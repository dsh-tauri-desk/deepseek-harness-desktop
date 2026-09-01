/**
 * MCP server rows in the profile's own patch layer: one
 * `@deepseek-ai/dsh-mcp-client` row per server. The YAML document API keeps
 * foreign rows and comments intact across edits. Row changes need a dsh
 * restart to compose — callers surface that as a pending-restart notice.
 *
 * The loader's patch grammar distinguishes creates from overrides: a bare
 * `- id: …` entry only overrides an existing row (target missing → skipped
 * with a warning), while new rows must live in an anonymous `- insert:`
 * list. Managed rows therefore always sit inside one insert entry, and any
 * legacy bare rows (written before this contract was understood) are
 * absorbed into it on the next write.
 */

import type { YAMLMap, YAMLSeq } from 'yaml'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { Document, parseDocument } from 'yaml'
/** The plugin every managed row instantiates. */
export const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** MCP serverName grammar (dsh-mcp-client's contract). */
export const SERVER_NAME_RE = /^[\w-]{1,32}$/

/** Transport choices the client supports. */
export type McpTransport = 'stdio' | 'streamable-http'

/** One managed row, as shown to the browser. */
export interface McpRow {
  id: string
  serverName: string
  transport: McpTransport
  disabled: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

/** Write request for one server row (id empty = create). */
export type McpInput = Omit<McpRow, 'disabled'> & { disabled?: boolean }

/** Load the profile patch as a YAML document; `[]` for a missing file. */
function loadPatch(profileDirPath: string): Document {
  const path = join(profileDirPath, 'cordis.patch.yml')
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '[]'
  const doc = parseDocument(text)
  const contents = doc.contents as YAMLSeq | null
  // The default-empty file parses as a flow `[]`; the patch layer is
  // human-edited block YAML, so flip the flag before anything appends.
  if (contents !== null && contents.flow === true && contents.items.length === 0)
    contents.flow = false
  return doc
}

function savePatch(profileDirPath: string, doc: Document): void {
  mkdirSync(profileDirPath, { recursive: true })
  writeFileSync(join(profileDirPath, 'cordis.patch.yml'), String(doc), 'utf8')
}

/** Wrap a plain value into a YAML node (yaml v2 exposes no standalone createNode). */
function toNode<T>(value: unknown): T {
  return new Document(value as never).contents as T
}

/** The patch row sequence; an empty file's null root becomes an empty seq. */
function rowSeq(doc: Document): YAMLSeq<YAMLMap> {
  if (doc.contents === null) {
    doc.contents = toNode<YAMLSeq<YAMLMap>>([])
    // An empty seq defaults to flow style (`[]`); the file must stay block.
    ;(doc.contents as YAMLSeq).flow = false
  }
  return doc.contents as YAMLSeq<YAMLMap>
}

function isSeqNode(value: unknown): value is YAMLSeq<YAMLMap> {
  return typeof value === 'object' && value !== null && Array.isArray((value as YAMLSeq).items)
}

/** A patch entry's insert list when it is the anonymous create form. */
function insertListOf(item: YAMLMap): YAMLSeq<YAMLMap> | undefined {
  if (item.has('id'))
    return undefined
  const node = item.get('insert')
  return isSeqNode(node) ? node : undefined
}

/** Every managed row: legacy bare entries (no list) and insert-list rows. */
function mcpRowItems(doc: Document): { node: YAMLMap, list?: YAMLSeq<YAMLMap> }[] {
  const found: { node: YAMLMap, list?: YAMLSeq<YAMLMap> }[] = []
  for (const item of rowSeq(doc).items ?? []) {
    if (item.get('name') === MCP_PLUGIN)
      found.push({ node: item })
    const list = insertListOf(item)
    for (const row of list?.items ?? []) {
      if (row.get('name') === MCP_PLUGIN)
        found.push({ node: row, list })
    }
  }
  return found
}

/** Map one row node to its browser-facing shape. */
function rowToMcp(doc: Document, item: YAMLMap): McpRow {
  // config is a YAMLMap node — materialize it before property access.
  const configNode = item.get('config') as unknown
  const plain = (typeof configNode === 'object' && configNode !== null && typeof (configNode as { toJS?: unknown }).toJS === 'function'
    ? (configNode as { toJS: (document: Document) => unknown }).toJS(doc)
    : {}) as Record<string, unknown>
  return {
    id: String(item.get('id') ?? ''),
    serverName: String(plain.serverName ?? ''),
    transport: plain.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    disabled: item.get('disabled') === true,
    ...(typeof plain.command === 'string' && plain.command !== '' ? { command: plain.command } : {}),
    ...(Array.isArray(plain.args) ? { args: plain.args.map(String) } : {}),
    ...(isStringMap(plain.env) ? { env: plain.env } : {}),
    ...(typeof plain.cwd === 'string' && plain.cwd !== '' ? { cwd: plain.cwd } : {}),
    ...(typeof plain.url === 'string' && plain.url !== '' ? { url: plain.url } : {}),
    ...(isStringMap(plain.headers) ? { headers: plain.headers } : {}),
  }
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  return Object.values(value).every(entry => typeof entry === 'string')
}

/**
 * The insert list that owns managed rows, creating it when absent and
 * absorbing legacy bare rows into it. Absorbed rows were inert under the
 * loader's override-only reading of bare entries, so the move is not just
 * cosmetic — it is what makes them compose.
 */
function managedInsert(doc: Document): YAMLSeq<YAMLMap> {
  const seq = rowSeq(doc)
  const bare: YAMLMap[] = []
  let target: YAMLSeq<YAMLMap> | undefined
  for (const item of seq.items ?? []) {
    if (item.get('name') === MCP_PLUGIN)
      bare.push(item)
    const list = insertListOf(item)
    if (list !== undefined && list.items.some(row => row.get('name') === MCP_PLUGIN))
      target ??= list
  }
  if (target === undefined) {
    const entry = toNode<YAMLMap>({ insert: [] })
    seq.add(entry)
    target = entry.get('insert') as YAMLSeq<YAMLMap>
    target.flow = false
  }
  for (const row of bare) {
    seq.items.splice(seq.items.indexOf(row), 1)
    target.add(row)
  }
  return target
}

/** Every id in use: top-level patch entries and rows inside insert lists. */
function takenIds(doc: Document): Set<string> {
  const taken = new Set<string>()
  for (const item of rowSeq(doc).items ?? []) {
    const id = String(item.get('id') ?? '')
    if (id !== '')
      taken.add(id)
    for (const row of insertListOf(item)?.items ?? []) {
      const rowId = String(row.get('id') ?? '')
      if (rowId !== '')
        taken.add(rowId)
    }
  }
  return taken
}

/** Read every mcp-client row in the profile layer. */
export function listMcp(profileDirPath: string): McpRow[] {
  const doc = loadPatch(profileDirPath)
  return mcpRowItems(doc).map(({ node }) => rowToMcp(doc, node))
}

/** Validate one write request; returns the rejection reason or null. */
export function validateMcpInput(input: McpInput): string | null {
  if (!SERVER_NAME_RE.test(input.serverName))
    return 'serverName must be 1-32 chars of A-Z a-z 0-9 _ -'
  // The route casts raw JSON to McpInput; a create request may omit `id`.
  const id = input.id ?? ''
  if (id.includes('/') || id.includes('..'))
    return 'invalid id'
  if (input.transport === 'stdio') {
    if (input.command === undefined || input.command.trim() === '')
      return 'stdio transport requires a command'
  }
  else if (input.url === undefined || !/^https?:\/\//.test(input.url)) {
    return 'http transport requires an http(s) url'
  }
  return null
}

/** Add or replace one server row. Returns the (possibly deduplicated) id. */
export function upsertMcp(profileDirPath: string, input: McpInput): string {
  const inputId = input.id ?? ''
  const doc = loadPatch(profileDirPath)
  const list = managedInsert(doc)

  const existing = inputId !== ''
    ? mcpRowItems(doc).find(({ node }) => String(node.get('id') ?? '') === inputId)
    : undefined

  let id = inputId !== '' ? inputId : `mcp-${input.serverName}`
  if (existing === undefined) {
    const taken = takenIds(doc)
    let suffix = 2
    while (taken.has(id)) id = `mcp-${input.serverName}-${suffix++}`
  }

  const config: Record<string, unknown> = input.transport === 'stdio'
    ? {
        serverName: input.serverName,
        transport: input.transport,
        command: input.command,
        ...(input.args !== undefined && input.args.length > 0 ? { args: input.args } : {}),
        ...(input.env !== undefined && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
        ...(input.cwd !== undefined && input.cwd !== '' ? { cwd: input.cwd } : {}),
      }
    : {
        serverName: input.serverName,
        transport: input.transport,
        url: input.url,
        ...(input.headers !== undefined && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
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
    // Bare rows were absorbed above; reaching here means a foreign-shaped row.
    rowSeq(doc).items.splice(rowSeq(doc).items.indexOf(existing.node), 1, node)
  }

  savePatch(profileDirPath, doc)
  return id
}

/** Flip one row's disabled flag (absent = enabled). Returns false when missing. */
export function setMcpDisabled(profileDirPath: string, id: string, disabled: boolean): boolean {
  const doc = loadPatch(profileDirPath)
  managedInsert(doc)
  const hit = mcpRowItems(doc).find(({ node }) => String(node.get('id') ?? '') === id)
  if (hit === undefined)
    return false
  if (disabled)
    hit.node.set('disabled', true)
  else hit.node.delete('disabled')
  savePatch(profileDirPath, doc)
  return true
}

/** Remove one server row. Returns false when missing. */
export function removeMcp(profileDirPath: string, id: string): boolean {
  const doc = loadPatch(profileDirPath)
  managedInsert(doc)
  const hit = mcpRowItems(doc).find(({ node }) => String(node.get('id') ?? '') === id)
  if (hit === undefined || hit.list === undefined)
    return false
  hit.list.items.splice(hit.list.items.indexOf(hit.node), 1)

  // An insert entry left with no rows is dead weight; drop it when the
  // insert list is all it holds.
  const seq = rowSeq(doc)
  const owner = (seq.items ?? []).find(item => insertListOf(item) === hit.list)
  if (owner !== undefined && hit.list.items.length === 0 && owner.items.length === 1) {
    seq.items.splice(seq.items.indexOf(owner), 1)
  }

  savePatch(profileDirPath, doc)
  return true
}
