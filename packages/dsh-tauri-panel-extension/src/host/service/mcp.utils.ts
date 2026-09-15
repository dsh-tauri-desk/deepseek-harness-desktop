import type { YAMLMap, YAMLSeq } from 'yaml'
import type { McpInput, McpRow, McpScope } from './mcp.types'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DSH_HOME } from 'dsh-tauri'
import { compact, every, isObject, isString, isUndefined, omitBy } from 'lodash-es'
import { join } from 'pathe'
import { Document, parseDocument } from 'yaml'
import { EMPTY_PATCH, MCP_PLUGIN, PATCH_FILE_NAME, SERVER_NAME_RE } from '../config/constants'

export function normalizeMcpScope(value: unknown): McpScope {
  return value === 'global' ? 'global' : 'profile'
}

export function mcpScopeDir(scope: McpScope, profileDirPath: string): string {
  return scope === 'global' ? DSH_HOME : profileDirPath
}

export function mcpRowToInput(row: McpRow): McpInput {
  const detail: Record<string, unknown> = row.transport === 'stdio'
    ? { args: row.args, env: row.env, cwd: row.cwd }
    : { headers: row.headers }
  return {
    id: '',
    serverName: row.serverName,
    transport: row.transport,
    disabled: row.disabled,
    ...(row.transport === 'stdio' ? { command: row.command } : { url: row.url }),
    ...omitBy(detail, isUndefined),
  }
}

export function validateMcpInput(input: McpInput): string | null {
  if (!SERVER_NAME_RE.test(input.serverName))
    return 'serverName must be 1-32 chars of A-Z a-z 0-9 _ -'
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

export function loadPatch(dirPath: string): Document {
  const path = join(dirPath, PATCH_FILE_NAME)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : EMPTY_PATCH
  const doc = parseDocument(text)
  assertPatchParses(path, doc)
  const contents = doc.contents as YAMLSeq | null
  if (contents !== null && contents.flow === true && contents.items.length === 0)
    contents.flow = false
  return doc
}

export function savePatch(dirPath: string, doc: Document): void {
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, PATCH_FILE_NAME), String(doc), 'utf8')
}

export function toNode<T>(value: unknown): T {
  return new Document(value as never).contents as T
}

export function rowSeq(doc: Document): YAMLSeq<YAMLMap> {
  if (doc.contents === null) {
    const seq = toNode<YAMLSeq<YAMLMap>>([])
    seq.flow = false
    doc.contents = seq
  }
  return doc.contents as YAMLSeq<YAMLMap>
}

export function insertListOf(item: YAMLMap): YAMLSeq<YAMLMap> | undefined {
  if (item.has('id'))
    return undefined
  const node = item.get('insert')
  return isSeqNode(node) ? node : undefined
}

export function mcpRowItems(doc: Document): { node: YAMLMap, list?: YAMLSeq<YAMLMap> }[] {
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

export function managedInsert(doc: Document): YAMLSeq<YAMLMap> {
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

export function takenIds(doc: Document): Set<string> {
  const nodes = (rowSeq(doc).items ?? []).flatMap(item => [item, ...(insertListOf(item)?.items ?? [])])
  return new Set(compact(nodes.map(node => String(node.get('id') ?? ''))))
}

export function readRows(dirPath: string): McpRow[] {
  const doc = loadPatch(dirPath)
  return mcpRowItems(doc).map(({ node }) => rowToMcp(doc, node))
}

// --- internal ---

function assertPatchParses(path: string, doc: Document): void {
  if (doc.errors.length === 0)
    return
  const at = String(doc.errors[0].message).split('\n', 1)[0]
  const total = doc.errors.length > 1 ? `, +${doc.errors.length - 1} more` : ''
  throw new Error(
    `配置文件 ${path} 存在 YAML 语法错误（${at}${total}），未写入任何内容，请修复该文件后重试`
    + ` / YAML syntax error in the patch file (${at}${total}); nothing was written — fix it and retry`,
  )
}

function isSeqNode(value: unknown): value is YAMLSeq<YAMLMap> {
  return typeof value === 'object' && value !== null && Array.isArray((value as YAMLSeq).items)
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isObject(value) || Array.isArray(value))
    return false
  return every(value, isString)
}

function rowToMcp(doc: Document, item: YAMLMap): McpRow {
  const configNode = item.get('config') as unknown
  const plain = (isObject(configNode) && typeof (configNode as { toJS?: unknown }).toJS === 'function'
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
