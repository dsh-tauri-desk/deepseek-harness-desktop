import type { ApiPipeline, StatementField, StatementInterface } from '@genapi/shared'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { createParser, parseMethodMetadata, parseMethodParameters, transformBodyStringify, transformFetchBody, transformHeaderOptions, transformParameters, transformQueryParams, transformUrlSyntax } from '@genapi/parser'
import pipeline, { compiler, config as configure, dest, generate } from '@genapi/pipeline'

/**
 * 自定义 genapi 管道：把每个插件 `src/host/routes/**` 的 handler 源码推导成 Swagger 2 规格，
 * 再走 genapi 既有 fetch/ts 流程生成 `src/client/apis/index.ts` 与 `index.type.ts`。
 *
 * 推导规则（文件路径 = URL 路径 = 函数名，与 PLUGIN_CLIENT.spec.md 一致）：
 *   `routes/session/archive/get.ts` → GET `${API_PREFIX}/session/archive` → `getSessionArchive`
 *   - 目录名逐段进入路径与函数名；`get.ts` / `post.ts` 这类动词文件名只决定 method
 *   - 请求参数取自 handler 的 `getQuery(event) as {...}` 与 `readBody<T>(event)`
 *   - 响应类型取自 `defineEventHandler((event): Promise<T> => ...)` 的返回注解
 *   - `src/client/types`、`src/shared/types`、`src/host/types` 里的类型声明递归展开进 definitions
 */
export interface GenapiServerConfig {
  /** host 路由目录，相对仓库根：`packages/<plugin>/src/host/routes`。 */
  routes: string
  /** 插件 src 根，默认由 routes 反推（`routes/../../..`）。 */
  src?: string
  /** 输出：字符串等价于 `{ main }`；type 由 genapi 按 main 派生为 `index.type.ts`。 */
  output: string | { main?: string, type?: string | false }
  /** 线协议前缀，默认读 `src/shared/constants.ts` 里的 `*_API_PREFIX` / `API_PREFIX`。 */
  apiPrefix?: string
  /** 规格标题，默认取插件包名。 */
  plugin?: string
  /** fetch 导入方式：默认命名导入 `import { fetch }`；`default` 为 `import fetch`。 */
  fetchImport?: 'named' | 'default'
}

const RE_HANDLER = /defineEventHandler\s*\(/
const RE_SKIP_FILE = /\.(?:test|spec)\.tsx?$|\.d\.ts$/
const RE_TS_FILE = /\.tsx?$/
const METHOD_FILES = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options'])
const reservedNames = new Set(['delete', 'new', 'await', 'yield', 'in', 'do', 'if', 'for', 'class', 'function', 'return', 'void', 'typeof', 'instanceof', 'switch', 'case', 'default', 'this', 'super', 'import', 'export', 'with'])
const TYPE_ROOTS = ['client/types', 'shared/types', 'host/types']

interface Declaration {
  name: string
  file: string
  kind: 'interface' | 'alias'
  body: string
  fields: StatementField[]
}

interface TypeIndex {
  declarations: Map<string, Declaration[]>
  imports: Map<string, Map<string, { file: string, names: Map<string, string> }>>
}

interface HandlerParameter {
  name: string
  location: 'query' | 'body'
  required: boolean
  schema: any
}

function readIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

function walkFiles(root: string, predicate: (file: string) => boolean): string[] {
  const found: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    }
    catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules')
        continue
      const full = resolve(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (predicate(full))
        found.push(full)
    }
  }
  return found.sort()
}

function operationName(method: string, segments: string[]): string {
  return reservedNames.has(method)
    ? `${method}${toIdentifier(segments)}Root`
    : `${method}${toIdentifier(segments)}`
}

function toIdentifier(segments: string[]): string {
  return segments
    .flatMap(segment => segment.split(/[^A-Z0-9]+/i))
    .filter(Boolean)
    .map(segment => segment[0].toUpperCase() + segment.slice(1))
    .join('')
}

function literalValue(source: string, expression: string): string | undefined {
  const known = new Map<string, string>()
  for (const match of source.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]+)/g))
    known.set(match[1], match[2].trim())
  let value = expression.trim()
  for (let round = 0; round < 6; round++) {
    const replaced = value.replace(/\$\{\s*([A-Z_$][\w$]*)\s*\}|([A-Z_$][\w$]*)/gi, (raw, inside, plain) => {
      const next = known.get(inside ?? plain)
      return next === undefined || next === raw ? raw : `(${next})`
    })
    if (replaced === value)
      break
    value = replaced
  }
  const template = value.trim()
  const unwrapped = template.startsWith('`') && template.endsWith('`') ? template.slice(1, -1) : template
  const candidate = unwrapped.replace(/[`'"]/g, '').trim()
  return /^\/[\w\-./]*$/.test(candidate) ? candidate : undefined
}

function resolveApiPrefix(constants: string | undefined, plugin: string, explicit?: string): string {
  if (explicit)
    return explicit.replace(/\/$/, '')
  if (constants !== undefined) {
    const declared = /export\s+const\s+\w*API_PREFIX\w*\s*=\s*([^\n]+)/.exec(constants)
    const value = declared ? literalValue(constants, declared[1]) : undefined
    if (value)
      return value.replace(/\/$/, '')
    const pathConstant = /export\s+const\s+\w+\s*=\s*(['"`]\/[^'"`\n]+['"`])/.exec(constants)
    const path = pathConstant ? literalValue(constants, pathConstant[1]) : undefined
    if (path) {
      const segments = path.split('/').filter(Boolean)
      if (segments.length >= 2 && segments[0] === 'api')
        return `/${segments.slice(0, 2).join('/')}`
      return `/${segments[0]}`
    }
  }
  return `/api/${plugin.replace(/^dsh-tauri-/, '')}`
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let quote: string | undefined
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (quote) {
      if (char === '\\') {
        index++
        continue
      }
      if (char === quote)
        quote = undefined
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{' || char === '[' || char === '(' || char === '<') {
      depth++
      continue
    }
    if (char === '}' || char === ']' || char === ')' || char === '>') {
      depth--
      continue
    }
    if ((char === ';' || char === '|') && depth === 0) {
      parts.push(input.slice(start, index))
      start = index + 1
    }
  }
  const tail = input.slice(start)
  if (tail.trim().length > 0)
    parts.push(tail)
  return parts.map(part => part.trim()).filter(Boolean)
}

function unwrap(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('{'))
    return (trimmed.endsWith('}') ? trimmed.slice(1, -1) : trimmed.slice(1)).trim()
  if (trimmed.startsWith('('))
    return (trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed.slice(1)).trim()
  return trimmed
}

function splitMembers(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let quote: string | undefined
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (quote) {
      if (char === '\\') {
        index++
        continue
      }
      if (char === quote)
        quote = undefined
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{' || char === '[' || char === '(') {
      depth++
      continue
    }
    if (char === '}' || char === ']' || char === ')') {
      depth--
      continue
    }
    const boundary = depth === 0 && (char === ';' || char === ',' || (char === '\n' && !/^\s*\|/.test(input.slice(index + 1))))
    if (boundary) {
      parts.push(input.slice(start, index))
      start = index + 1
    }
  }
  const tail = input.slice(start)
  if (tail.trim().length > 0)
    parts.push(tail)
  return parts.map(part => part.trim().replace(/^[;,]/, '').replace(/[;,]$/, '').trim()).filter(Boolean)
}

function parseFields(body: string): StatementField[] {
  const fields: StatementField[] = []
  for (const member of splitMembers(unwrap(body))) {
    const match = /^(?:readonly\s+)?(?:\[[^\]]+\]|['"]?(\w+)['"]?)(\??)\s*:\s*(\S[\s\S]*)$/.exec(member)
    if (!match)
      continue
    fields.push({ name: match[1], type: match[3].replace(/;$/, '').trim(), required: match[2] !== '?' })
  }
  return fields
}

function genericArgs(input: string): string[] {
  const start = input.indexOf('<')
  if (start < 0)
    return []
  let depth = 0
  let quote: string | undefined
  for (let index = start; index < input.length; index++) {
    const char = input[index]
    if (quote) {
      if (char === '\\') {
        index++
        continue
      }
      if (char === quote)
        quote = undefined
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '<') {
      depth++
      continue
    }
    if (char === '>') {
      depth--
      if (depth === 0)
        return splitTopLevel(input.slice(start + 1, index))
    }
  }
  return []
}

function genericOf(source: string, name: string): string | undefined {
  const found = new RegExp(`\\b${name}\\s*<`).exec(source)
  if (!found)
    return undefined
  const start = found.index + found[0].length
  let depth = 0
  let quote: string | undefined
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === '\\') {
        index++
        continue
      }
      if (char === quote)
        quote = undefined
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '<') {
      depth++
      continue
    }
    if (char === '>') {
      if (depth === 0)
        return source.slice(start, index).trim()
      depth--
    }
  }
  return undefined
}

function sliceBalanced(source: string, openIndex: number): string | undefined {
  let depth = 0
  let quote: string | undefined
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === '\\') {
        index++
        continue
      }
      if (char === quote)
        quote = undefined
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{' || char === '[' || char === '(') {
      depth++
      continue
    }
    if (char === '}' || char === ']' || char === ')') {
      depth--
      if (depth === 0)
        return source.slice(openIndex + 1, index)
    }
  }
  return undefined
}

function sliceDeclaration(source: string, start: number): string | undefined {
  let depth = 0
  let quote: string | undefined
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === '\\') {
        index++
        continue
      }
      if (char === quote)
        quote = undefined
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{' || char === '[' || char === '(' || char === '<') {
      depth++
      continue
    }
    if (char === '}' || char === ']' || char === ')' || char === '>') {
      depth--
      continue
    }
    if (char === '\n' && depth === 0)
      return source.slice(start, index).trim()
  }
  return source.slice(start).trim()
}

function extractDeclarations(source: string, file: string, target: Map<string, Declaration[]>) {
  const push = (declaration: Declaration) => {
    const list = target.get(declaration.name) ?? []
    list.push(declaration)
    target.set(declaration.name, list)
  }
  for (const match of source.matchAll(/(?:export\s+)?(?:declare\s+)?interface\s+(\w+)\s*\{/g)) {
    const body = sliceBalanced(source, match.index! + match[0].length - 1)
    if (body !== undefined)
      push({ name: match[1], file, kind: 'interface', body, fields: parseFields(body) })
  }
  for (const match of source.matchAll(/(?:export\s+)?(?:declare\s+)?type\s+(\w+)\s*=\s*/g)) {
    const body = sliceDeclaration(source, match.index! + match[0].length)
    if (body !== undefined)
      push({ name: match[1], file, kind: 'alias', body, fields: parseFields(body) })
  }
}

function importNames(clause: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const raw of splitTopLevel(clause)) {
    const part = raw.startsWith('type ') ? raw.slice(5).trim() : raw
    const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part)
    if (aliased) {
      names.set(aliased[2], aliased[1])
      continue
    }
    if (/^[A-Z_$][\w$]*$/i.test(part))
      names.set(part, part)
  }
  return names
}

function resolveSpecifier(file: string, specifier: string): string | undefined {
  const base = resolve(dirname(file), specifier)
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
    if (existsSync(candidate))
      return candidate
  }
  return undefined
}

function collectImports(source: string, file: string): Map<string, { file: string, names: Map<string, string> }> {
  const map = new Map<string, { file: string, names: Map<string, string> }>()
  for (const statement of source.matchAll(/import[^\n]*?from\s*['"][^'"]+['"]/g)) {
    const parts = /\bfrom\s*['"]([^'"]+)['"]\s*$/.exec(statement[0])
    if (!parts)
      continue
    const specifier = parts[1]
    if (!specifier.startsWith('.'))
      continue
    const clause = statement[0].slice('import'.length, statement[0].lastIndexOf('from')).trim().replace(/^type\s+/, '')
    if (clause.startsWith('*'))
      continue
    const defaultMatch = /^\w+\s*,?\s*/.exec(clause)
    const rest = defaultMatch ? clause.slice(defaultMatch[0].length) : clause
    const brace = /\{([\s\S]*)\}/.exec(rest)
    if (!brace)
      continue
    const names = importNames(brace[1])
    if (names.size === 0)
      continue
    const target = resolveSpecifier(file, specifier)
    if (target)
      map.set(specifier, { file: target, names })
  }
  return map
}

function typesRank(file: string): number {
  if (/[\\/]src[\\/]client[\\/]types[\\/]/.test(file))
    return 0
  if (/[\\/]src[\\/](?:shared|host)[\\/]types[\\/]/.test(file))
    return 1
  if (/[\\/]types[\\/]/.test(file))
    return 2
  return 3
}

function buildTypeIndex(src: string): TypeIndex {
  const index: TypeIndex = { declarations: new Map(), imports: new Map() }
  for (const part of TYPE_ROOTS) {
    const root = resolve(src, part)
    if (!existsSync(root))
      continue
    for (const file of walkFiles(root, candidate => RE_TS_FILE.test(candidate) && !RE_SKIP_FILE.test(candidate))) {
      const source = readFileSync(file, 'utf8')
      index.imports.set(file, collectImports(source, file))
      extractDeclarations(source, file, index.declarations)
    }
  }
  return index
}

function lookup(index: TypeIndex, name: string, file: string): Declaration | undefined {
  const scope = index.imports.get(file)
  const entry = scope ? [...scope.values()].find(candidate => candidate.names.has(name)) : undefined
  if (entry) {
    const original = entry.names.get(name)!
    const candidates = index.declarations.get(original) ?? []
    const preferred = candidates.find(candidate => candidate.file === entry.file) ?? candidates[0]
    if (preferred)
      return preferred
  }
  const candidates = index.declarations.get(name) ?? []
  const local = candidates.find(candidate => candidate.file === file)
  if (local)
    return local
  const ranked = [...candidates].sort((a, b) => typesRank(a.file) - typesRank(b.file) || a.file.localeCompare(b.file))
  return ranked[0]
}

function toSchema(type: string, index: TypeIndex, file: string, definitions: Record<string, any>, referenced: Set<string>): any {
  const trimmed = type.trim()
  if (trimmed.length === 0)
    return { type: 'string' }
  if (trimmed.startsWith('{'))
    return objectSchema(trimmed, index, file, definitions, referenced)
  if (trimmed.startsWith('[') && trimmed.endsWith(']'))
    return { type: 'array', items: toSchema(splitTopLevel(trimmed.slice(1, -1))[0] ?? 'unknown', index, file, definitions, referenced) }
  if (trimmed.includes('=>'))
    return { type: 'string' }
  const parts = splitTopLevel(trimmed)
  if (parts.length > 1)
    return unionSchema(parts, index, file, definitions, referenced)
  if (trimmed.endsWith('[]'))
    return { type: 'array', items: toSchema(trimmed.slice(0, -2), index, file, definitions, referenced) }
  const literal = /^['"]([^'"]*)['"]$/.exec(trimmed)
  if (literal)
    return { type: 'string', enum: [literal[1]] }
  if (trimmed === 'string' || trimmed === 'number' || trimmed === 'boolean')
    return { type: trimmed }
  if (trimmed === 'unknown' || trimmed === 'any' || trimmed === 'object' || trimmed.startsWith('typeof '))
    return { type: 'string' }
  const generic = /^([A-Z_$][\w$.]*)\s*</i.exec(trimmed)
  if (generic) {
    const args = genericArgs(trimmed)
    if (generic[1] === 'Record')
      return { type: 'object', additionalProperties: toSchema(args[1] ?? 'unknown', index, file, definitions, referenced) }
    if (generic[1] === 'Array' || generic[1] === 'ReadonlyArray' || generic[1] === 'Set')
      return { type: 'array', items: toSchema(args[0] ?? 'unknown', index, file, definitions, referenced) }
    if (['Partial', 'Required', 'Readonly', 'NonNullable', 'Promise'].includes(generic[1]))
      return toSchema(args[0] ?? 'unknown', index, file, definitions, referenced)
    return { type: 'object', additionalProperties: { type: 'string' } }
  }
  const reference = /^([A-Z_$][\w$]*)$/i.exec(trimmed)
  if (reference) {
    const declaration = lookup(index, reference[1], file)
    if (declaration) {
      ensureDefinition(declaration, reference[1], index, definitions, referenced)
      return { $ref: `#/definitions/${reference[1]}` }
    }
  }
  return { type: 'string' }
}

function unionSchema(parts: string[], index: TypeIndex, file: string, definitions: Record<string, any>, referenced: Set<string>): any {
  const members = parts.map(part => toSchema(part, index, file, definitions, referenced))
  const nonNull = members.filter(member => member.type !== 'null')
  if (nonNull.length === 0)
    return { type: 'null' }
  const nullable = members.length !== nonNull.length
  if (nonNull.length === 1 && nullable)
    return { ...nonNull[0], nullable: true }
  if (nonNull.every(member => typeof member.enum?.[0] === 'string'))
    return { type: 'string', enum: nonNull.map(member => member.enum[0]), ...nullable ? { nullable: true } : {} }
  if (nonNull.every(member => member.type === 'boolean'))
    return { type: 'boolean', ...nullable ? { nullable: true } : {} }
  if (nonNull.every(member => member.type === 'number'))
    return { type: 'number', ...nullable ? { nullable: true } : {} }
  if (nonNull.every(member => member.type === 'string'))
    return { type: 'string', ...nullable ? { nullable: true } : {} }
  return nullable ? { ...nonNull[0], nullable: true } : {}
}

function objectSchema(type: string, index: TypeIndex, file: string, definitions: Record<string, any>, referenced: Set<string>): any {
  const fields = parseFields(unwrap(type))
  if (fields.length === 0)
    return { type: 'object', additionalProperties: { type: 'string' } }
  const properties: Record<string, any> = {}
  const required: string[] = []
  for (const field of fields) {
    properties[field.name] = toSchema(field.type === 'unknown' ? 'string' : field.type ?? 'string', index, file, definitions, referenced)
    if (field.required)
      required.push(field.name)
  }
  return required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties }
}

function ensureDefinition(declaration: Declaration, name: string, index: TypeIndex, definitions: Record<string, any>, referenced: Set<string>): any {
  if (definitions[name] !== undefined)
    return definitions[name]
  if (referenced.has(name))
    return undefined
  referenced.add(name)
  const target: any = {}
  definitions[name] = target
  const resolved = declaration.kind === 'interface'
    ? objectSchema(`{${declaration.body}}`, index, declaration.file, definitions, referenced)
    : toSchema(declaration.body, index, declaration.file, definitions, referenced)
  Object.assign(target, resolved)
  return target
}

function handlerParameters(source: string, operation: string, index: TypeIndex, file: string, definitions: Record<string, any>, referenced: Set<string>): HandlerParameter[] {
  const parameters: HandlerParameter[] = []
  const queryCast = /getQuery\s*\([^)]*\)\s*as\s*(\{[\s\S]*?\})\s*[;)\n]/.exec(source)
  const queryType = genericOf(source, 'getQuery')
  const queryFields = queryCast ? parseFields(queryCast[1]) : queryType?.startsWith('{') ? parseFields(queryType) : []
  for (const field of queryFields) {
    parameters.push({
      name: field.name,
      location: 'query',
      required: field.required === true,
      schema: toSchema(field.type === 'unknown' ? 'string' : field.type ?? 'string', index, file, definitions, referenced),
    })
  }
  if (queryFields.length === 0 && queryType && !queryType.startsWith('{')) {
    const declaration = lookup(index, queryType, file)
    if (declaration) {
      ensureDefinition(declaration, queryType, index, definitions, referenced)
      parameters.push({ name: 'query', location: 'query', required: true, schema: { $ref: `#/definitions/${queryType}` } })
    }
  }
  const bodyType = genericOf(source, 'readBody')
  if (bodyType) {
    if (bodyType.startsWith('{')) {
      const name = `${operation}Body`
      definitions[name] = objectSchema(bodyType, index, file, definitions, referenced)
      referenced.add(name)
      parameters.push({ name: 'body', location: 'body', required: true, schema: { $ref: `#/definitions/${name}` } })
      return parameters
    }
    const declaration = lookup(index, bodyType, file)
    if (declaration)
      ensureDefinition(declaration, bodyType, index, definitions, referenced)
    parameters.push({ name: 'body', location: 'body', required: true, schema: { $ref: `#/definitions/${bodyType}` } })
  }
  return parameters
}

function scanArrow(input: string): string | undefined {
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (quote) {
      if (char === '\\') {
        index++
        continue
      }
      if (char === quote)
        quote = undefined
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{' || char === '[' || char === '(') {
      depth++
      continue
    }
    if (char === '}' || char === ']' || char === ')') {
      depth--
      continue
    }
    if (char === '=' && input[index + 1] === '>' && depth === 0)
      return input.slice(0, index).trim()
  }
  return undefined
}

function unwrapPromise(value: string): string {
  if (!value.startsWith('Promise') || !value.endsWith('>'))
    return value
  const open = value.indexOf('<')
  if (open < 0)
    return value
  return value.slice(open + 1, -1).trim()
}

function handlerReturnAnnotation(source: string): string | undefined {
  const start = RE_HANDLER.exec(source)
  if (!start)
    return undefined
  const open = source.indexOf('(', start.index)
  if (open < 0)
    return undefined
  const afterOpen = source.slice(open + 1)
  const leading = /^\s*/.exec(afterOpen)![0].length
  const withAsync = /^\s*(?:async\s*)?/.exec(afterOpen)![0].length
  const paramsOpen = source[open + 1 + withAsync] === '(' ? open + 1 + withAsync : open + 1 + leading
  if (source[paramsOpen] !== '(')
    return undefined
  const parameters = sliceBalanced(source, paramsOpen)
  if (parameters === undefined)
    return undefined
  const close = paramsOpen + parameters.length + 1
  const after = source.slice(close + 1)
  if (!/^\s*:/.test(after))
    return undefined
  const annotation = scanArrow(after.replace(/^\s*:\s*/, ''))
  return annotation ? unwrapPromise(annotation) : undefined
}

function operationResponse(source: string, index: TypeIndex, file: string, definitions: Record<string, any>, referenced: Set<string>): any {
  const annotation = handlerReturnAnnotation(source)
  if (!annotation)
    return undefined
  const candidates = splitTopLevel(annotation)
  const named = candidates.find(candidate => /^[A-Z_$][\w$]*$/i.test(candidate.trim()))
  if (named) {
    const declaration = lookup(index, named.trim(), file)
    if (declaration) {
      ensureDefinition(declaration, named.trim(), index, definitions, referenced)
      return { $ref: `#/definitions/${named.trim()}` }
    }
  }
  const primitive = candidates.find(candidate => /^(?:string|number|boolean|string\[\]|number\[\]|boolean\[\])$/.test(candidate.trim()))
  if (primitive) {
    const trimmed = primitive.trim()
    return trimmed.endsWith('[]') ? { type: 'array', items: { type: trimmed.slice(0, -2) } } : { type: trimmed }
  }
  const objectLiteral = candidates.find(candidate => candidate.trim().startsWith('{'))
  if (objectLiteral)
    return objectSchema(objectLiteral, index, file, definitions, referenced)
  return undefined
}

interface RouteFile {
  segments: string[]
  method: string
  file: string
}

function collectRouteFiles(routesDir: string): RouteFile[] {
  const found: RouteFile[] = []
  for (const file of walkFiles(routesDir, candidate => RE_TS_FILE.test(candidate) && !RE_SKIP_FILE.test(candidate))) {
    const parts = toPosix(relative(routesDir, file)).split('/')
    const stem = parts.pop()!.replace(/\.tsx?$/, '')
    if (stem === 'index' || stem.endsWith('.types') || stem.endsWith('.type'))
      continue
    if (!METHOD_FILES.has(stem))
      continue
    found.push({ segments: parts, method: stem, file })
  }
  return found
}

function resolveSrc(cwd: string, server: GenapiServerConfig, routesDir: string): string {
  if (server.src)
    return resolve(cwd, server.src)
  const candidates = [
    resolve(routesDir, '..', '..'),
    resolve(routesDir, '..', '..', '..'),
    resolve(routesDir, '..', '..', '..', '..'),
  ]
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'shared')) || existsSync(resolve(candidate, 'client')) || existsSync(resolve(candidate, 'host')))
      return candidate
  }
  return resolve(routesDir, '..', '..', '..')
}

function buildSource(configRead: ApiPipeline.ConfigRead, server: GenapiServerConfig): ApiPipeline.ConfigRead {
  const cwd = process.cwd()
  const routesDir = resolve(cwd, server.routes)
  const src = resolveSrc(cwd, server, routesDir)
  const plugin = server.plugin ?? toPosix(relative(cwd, src)).split('/')[1] ?? 'plugin'
  const apiPrefix = resolveApiPrefix(readIfExists(resolve(src, 'shared/constants.ts')), plugin, server.apiPrefix)
  configRead.config.meta ??= {}
  configRead.config.meta.baseURL = `"${apiPrefix}"`
  configRead.config.meta.import ??= {}
  configRead.config.meta.import.http ??= 'dsh-tauri/client'
  configRead.graphs.scopes.main ??= { comments: [], functions: [], imports: [], variables: [], typings: [], interfaces: [] }
  configRead.graphs.scopes.main.imports ??= []
  const httpImport = configRead.config.meta.import.http
  const imports = configRead.graphs.scopes.main.imports
  const kept = imports.filter(item => item.value !== httpImport)
  kept.unshift(server.fetchImport === 'default' ? { name: 'fetch', value: httpImport } : { names: ['fetch'], value: httpImport })
  configRead.graphs.scopes.main.imports = kept
  const index = buildTypeIndex(src)
  const definitions: Record<string, any> = {}
  const referenced = new Set<string>()
  const paths: Record<string, any> = {}
  for (const route of collectRouteFiles(routesDir)) {
    const source = readFileSync(route.file, 'utf8')
    index.imports.set(route.file, collectImports(source, route.file))
    extractDeclarations(source, route.file, index.declarations)
    const url = `${apiPrefix}${route.segments.length > 0 ? `/${route.segments.join('/')}` : ''}`
    const specPath = route.segments.length > 0 ? `/${route.segments.join('/')}` : '/'
    const operation = operationName(route.method, route.segments)
    const parameters = handlerParameters(source, operation, index, route.file, definitions, referenced).map((parameter) => {
      const { name, location, required, schema } = parameter
      return location === 'body'
        ? { name, in: 'body', required, schema }
        : { name, in: 'query', required, ...schema }
    })
    const responseSchema = operationResponse(source, index, route.file, definitions, referenced)
    paths[specPath] ??= {}
    paths[specPath][route.method] = {
      operationId: operation,
      parameters,
      responses: { 200: responseSchema ? { description: `${route.method.toUpperCase()} ${url}`, schema: responseSchema } : { description: `${route.method.toUpperCase()} ${url}` } },
    }
  }
  const reachable = new Set<string>()
  const walk = (schema: any) => {
    if (Array.isArray(schema)) {
      for (const item of schema)
        walk(item)
      return
    }
    if (!schema || typeof schema !== 'object')
      return
    if (typeof schema.$ref === 'string') {
      const name = schema.$ref.split('/').pop()!
      if (!reachable.has(name)) {
        reachable.add(name)
        walk(definitions[name])
      }
      return
    }
    for (const value of Object.values(schema))
      walk(value)
  }
  for (const methods of Object.values(paths))
    walk(methods)
  const pruned: Record<string, any> = {}
  for (const name of reachable) {
    if (definitions[name] !== undefined)
      pruned[name] = definitions[name]
  }
  configRead.source = {
    swagger: '2.0',
    info: { title: plugin, version: '0.0.0' },
    paths,
    definitions: pruned,
  }
  return configRead
}

const routeParser = createParser((config, { configRead, functions, interfaces }) => {
  const { parameters, interfaces: attached, options } = parseMethodParameters(config as any)
  const meta = parseMethodMetadata(config as any)
  attached.forEach(item => interfaces.add('type', item as StatementInterface))
  parameters.push({ name: 'config', type: 'RequestInit', required: false })
  if (config.method.toLowerCase() !== 'get')
    options.unshift(['method', `"${config.method}"`])
  transformHeaderOptions('body', { options, parameters })
  options.push(['...', 'config'])
  const { spaceResponseType } = transformParameters(parameters, {
    syntax: 'typescript',
    configRead,
    description: meta.description,
    interfaces: interfaces.all(),
    responseType: meta.responseType,
  } as any)
  transformBodyStringify('body', { options, parameters })
  const url = transformQueryParams('query', { body: meta.body, options, url: meta.url })
  const requestUrl = transformUrlSyntax(url, { baseURL: configRead.config.meta?.baseURL })
  const name = reservedNames.has(meta.name) ? `${meta.name}Root` : meta.name
  functions.add('main', {
    export: true,
    async: true,
    name,
    description: meta.description,
    parameters,
    body: [...(meta.body ?? []), ...transformFetchBody(requestUrl, options as any, spaceResponseType)],
  })
})

const written = new Set<string>()
const MARKER = '@generated by genapi'
const BANNER = `/**
 * 禁止修改 — ${MARKER}
 *
 * 本文件由 \`pnpm genapi\` 依据插件 host 路由（\`src/host/routes/**\`）自动生成，
 * 任何手工改动都会在下次生成时被覆盖；缺少本标记的文件会被生成器拒绝覆盖。
 * 需要调整接口请改 host 路由后重新运行 \`pnpm genapi\`。
 */

`

function guardWrites(configRead: ApiPipeline.ConfigRead, force: boolean): void {
  for (const output of configRead.outputs) {
    if (written.has(output.path))
      throw new Error(`genapi: 输出路径重复，请为每个 server 指定不同的 output：${output.path}`)
    written.add(output.path)
    if (force || !existsSync(output.path))
      continue
    const current = readFileSync(output.path, 'utf8')
    if (current.trim().length === 0 || current.includes(MARKER))
      continue
    throw new Error(`genapi: 拒绝覆盖手写文件 ${relative(process.cwd(), output.path)}（缺少 "${MARKER}" 标记）。确认要重新生成请设置 GENAPI_FORCE=1。`)
  }
}

function markOutputs(configRead: ApiPipeline.ConfigRead): ApiPipeline.ConfigRead {
  for (const output of configRead.outputs) {
    if (!output.code || output.code.includes(MARKER))
      continue
    output.code = BANNER + output.code
  }
  return configRead
}
export function pluginPipeline(userConfig: ApiPipeline.Config): Promise<void> {
  const force = process.env.GENAPI_FORCE === '1'
  return pipeline(
    (config: ApiPipeline.Config) => {
      const configRead = configure(config)
      guardWrites(configRead, force)
      return configRead
    },
    (configRead: ApiPipeline.ConfigRead) => {
      const server = (configRead.config as ApiPipeline.Config & { server?: GenapiServerConfig }).server
      return server ? buildSource(configRead, server) : configRead
    },
    routeParser,
    compiler,
    generate,
    (configRead: ApiPipeline.ConfigRead) => {
      const marked = markOutputs(configRead)
      return dest(marked) as unknown as void
    },
  )(userConfig) as unknown as Promise<void>
}
