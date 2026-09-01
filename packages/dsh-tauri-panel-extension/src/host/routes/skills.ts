/**
 * routes/skills.ts — 技能目录 HTTP 路由（skills / skill 读写 / policy / 打开目录）。
 *
 * 只做参数化与转发：文件系统与目录发现逻辑在 ../service/skills.ts / ../storage/index.ts，
 * 技能的宿主目录列表读 host.skills。路由级安全边界（同源校验、可写性判定、
 * 服务端解析目标路径）集中在本文件。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SkillInput } from '../service/skills.ts'
import type { SkillRootEntry } from '../storage/index.ts'
import type { HostSkill, PanelExtensionHost, RouteRegistrar, SkillRepositoryMetadata } from '../types/index.ts'
import { mkdirSync } from 'node:fs'
import process from 'node:process'
import { readJsonBody, sameOrigin, sendJson } from 'dsh-tauri'
import { isAbsolute, join, relative, resolve, sep } from 'pathe'
import { API_PREFIX } from '../../shared/constants.ts'
import { openDirectory } from '../service/opener.ts'
import { deleteSkill, setSkillPolicy, updateSkillFile, userSkillsDir, validateSkillInput, writeSkill } from '../service/skills.ts'
import { loadState, pluginStateDir } from '../storage/index.ts'

/** One catalog skill as the browser sees it (edit flags and repository metadata added). */
export type SkillRow = HostSkill & {
  editable: boolean
  removable: boolean
  dir?: string
  policyEditable: boolean
  /** Registered root containing this skill, if any. */
  repository?: SkillRepositoryMetadata
}

/**
 * A 'custom' skill is writable only when its folder sits inside a root this
 * plugin manages: the materialized repositories under the plugin state dir,
 * or a registered local root. Vendored skills shipped inside the plugin
 * package (under node_modules) are custom-sourced too but stay read-only —
 * edits there would die with the next plugin update.
 */
function customSkillWritable(dir: string, dshHome: string | undefined): boolean {
  const state = pluginStateDir(dshHome)
  if (dir === state || dir.startsWith(state + sep))
    return true
  return loadState(dshHome).skillRoots.some(entry =>
    entry.roots.some(root => dir === root || dir.startsWith(root + sep)))
}

/** Whether the save route may write this catalog row back to disk. */
function skillWritable(skill: HostSkill, dir: string | undefined, dshHome: string | undefined): boolean {
  if (dir === undefined)
    return false
  if (skill.source === 'user-dsh')
    return true
  return skill.source === 'custom' && customSkillWritable(dir, dshHome)
}

function pathWithin(path: string, parent: string): boolean {
  const child = resolve(path)
  const root = resolve(parent)
  const nested = relative(root, child)
  return nested === '' || (!nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested))
}

/** Match a catalog row to the registered root that contributed its directory. */
function repositoryForSkill(
  skill: HostSkill,
  entries: SkillRootEntry[],
): SkillRepositoryMetadata | undefined {
  const dir = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : undefined
  if (dir === undefined)
    return undefined
  const entry = entries.find(candidate => candidate.roots.some(root => pathWithin(dir, root)))
  if (entry === undefined)
    return undefined
  return {
    id: entry.id,
    label: entry.label,
    kind: entry.kind,
    ...(entry.kind === 'git' && entry.url !== undefined ? { githubUrl: entry.url } : {}),
  }
}

function toSkillRow(skill: HostSkill, entries: SkillRootEntry[], dshHome: string | undefined): SkillRow {
  const dir = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : undefined
  const repository = repositoryForSkill(skill, entries)
  return {
    ...skill,
    editable: skillWritable(skill, dir, dshHome),
    removable: skill.source === 'user-dsh',
    ...(dir !== undefined ? { dir } : {}),
    policyEditable: dir !== undefined,
    ...(repository !== undefined ? { repository } : {}),
  }
}

/** Repository skills are first; groups retain the registry's stable order. */
function sortSkillRows(rows: SkillRow[]): SkillRow[] {
  return rows.map((row, index) => ({ row, index }))
    .sort((left, right) => Number(right.row.repository !== undefined) - Number(left.row.repository !== undefined) || left.index - right.index)
    .map(item => item.row)
}

/** The route body shapes the skill routes accept (partial input / delete / policy). */
interface SkillDeleteBody { name?: unknown }
interface SkillPolicyBody { name?: unknown, enabled?: unknown }
interface SkillOpenBody { target?: unknown, name?: unknown, id?: unknown }

export function registerSkillRoutes(
  register: RouteRegistrar,
  host: PanelExtensionHost,
): Array<() => void> {
  const disposers: Array<() => void> = []
  const dshHome = process.env.DSH_HOME

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/skills`,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        const skills = await host.skills.list()
        const entries = loadState(dshHome).skillRoots
        const rows = skills.map(skill => toSkillRow(skill, entries, dshHome))
        sendJson(response, 200, { skills: sortSkillRows(rows) })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/skill`,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const name = url.searchParams.get('name') ?? ''
      try {
        const definition = await host.skills.get(name)
        if (definition === undefined) {
          sendJson(response, 404, { error: 'skill not found' })
          return
        }
        sendJson(response, 200, { name: definition.name, content: definition.content })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/skill/save`,
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
        const body = (await readJsonBody(request)) as Partial<SkillInput>
        const input: SkillInput = {
          name: typeof body.name === 'string' ? body.name : '',
          description: typeof body.description === 'string' ? body.description : '',
          whenToUse: typeof body.whenToUse === 'string' ? body.whenToUse : undefined,
          modelInvocable: body.modelInvocable !== false,
          userInvocable: body.userInvocable !== false,
          content: typeof body.content === 'string' ? body.content : '',
        }
        const invalid = validateSkillInput(input)
        if (invalid !== null) {
          sendJson(response, 400, { error: invalid })
          return
        }
        // An existing skill edits in place (its own folder, whichever
        // editable source it comes from — preserving frontmatter keys the
        // editor does not own); a new name creates in the user root. The
        // file location is resolved server-side from the catalog, never
        // taken from the request.
        const existing = (await host.skills.list()).find(skill => skill.name === input.name)
        if (existing !== undefined) {
          const dir = existing.resourceBase?.kind === 'directory' ? existing.resourceBase.path : undefined
          if (!skillWritable(existing, dir, dshHome)) {
            sendJson(response, 403, { error: `skills from source '${existing.source}' are read-only` })
            return
          }
          updateSkillFile(join(dir as string, 'SKILL.md'), input)
        }
        else {
          writeSkill(input)
        }
        sendJson(response, 200, { ok: true, name: input.name })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/skill/delete`,
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
        const body = (await readJsonBody(request)) as SkillDeleteBody
        const name = typeof body.name === 'string' ? body.name : ''
        const removed = deleteSkill(name)
        sendJson(response, removed ? 200 : 404, removed ? { ok: true, name } : { error: 'skill not found' })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/skill/policy`,
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
        const body = (await readJsonBody(request)) as SkillPolicyBody
        if (typeof body.name !== 'string' || typeof body.enabled !== 'boolean') {
          sendJson(response, 400, { error: 'name and enabled are required' })
          return
        }
        const definition = await host.skills.get(body.name)
        if (definition === undefined) {
          sendJson(response, 404, { error: 'skill not found' })
          return
        }
        if (definition.path === undefined) {
          sendJson(response, 422, { error: 'skill has no file on disk (runtime-registered)' })
          return
        }
        setSkillPolicy(definition.path, body.enabled)
        sendJson(response, 200, { ok: true })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${API_PREFIX}/open`,
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
        const body = (await readJsonBody(request)) as SkillOpenBody
        if (typeof body.target !== 'string') {
          sendJson(response, 400, { error: 'target is required' })
          return
        }
        // Targets are resolved server-side; the browser never supplies a
        // raw path, so this cannot be turned into an arbitrary open.
        let dir: string | undefined
        if (body.target === 'user-skills') {
          dir = userSkillsDir()
          // 用户还没建过任何技能时该目录不存在；「打开技能目录」应按需创建而非报错。
          mkdirSync(dir, { recursive: true })
        }
        else if (body.target === 'plugin-state') {
          dir = pluginStateDir()
          mkdirSync(dir, { recursive: true })
        }
        else if (body.target === 'skill') {
          if (typeof body.name !== 'string') {
            sendJson(response, 400, { error: 'name is required' })
            return
          }
          const definition = await host.skills.get(body.name)
          if (definition === undefined) {
            sendJson(response, 404, { error: 'skill not found' })
            return
          }
          dir = definition.path !== undefined
            ? definition.path.replace(/[/\\]SKILL\.md$/, '').replace(/[/\\][^/\\]+\.md$/, '')
            : definition.resourceBase?.kind === 'directory' ? definition.resourceBase.path : undefined
        }
        else if (body.target === 'root') {
          if (typeof body.id !== 'string') {
            sendJson(response, 400, { error: 'id is required' })
            return
          }
          const entry = loadState().skillRoots.find(row => row.id === body.id)
          if (entry === undefined) {
            sendJson(response, 404, { error: 'repository not found' })
            return
          }
          dir = entry.materialDir ?? entry.path ?? entry.roots[0]
        }
        else {
          sendJson(response, 400, { error: 'unknown target' })
          return
        }
        if (dir === undefined || !openDirectory(dir)) {
          sendJson(response, 422, { error: 'directory is not available on disk' })
          return
        }
        sendJson(response, 200, { ok: true })
      }
      catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  return disposers
}
