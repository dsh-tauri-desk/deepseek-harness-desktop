/**
 * Custom skill repositories the user registers from the Settings page:
 * a local directory (scanned in place, zero-copy) or a GitHub repo (tarball
 * download into the plugin's state dir, no git dependency). Detection adapts
 * to the three layouts skill collections actually use — one skill at the
 * repo root, skills as immediate children, or a nested `skills/`-style
 * folder — and registers the matching scan roots for the filesystem
 * provider.
 */

import type { SkillRootEntry } from '../storage/index.ts'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import process from 'node:process'
import { $fetch } from 'ofetch'
import { basename, join, resolve } from 'pathe'
import { addSkillRoot, findRootByUrl, materialDirFor, newEntryId } from '../storage/index.ts'
import { removeTree } from './rmtree.ts'
import { extractTarGz } from './tar.ts'

/** One GitHub source, parsed from whatever URL shape the user pasted. */
export interface GitHubSource {
  owner: string
  repo: string
  ref?: string
  /** `owner/repo`, the display label and dedupe key. */
  label: string
  /** Canonical browser URL exposed to the client as clickable metadata. */
  githubUrl: string
  tarballUrl: string
}

const GITHUB_URL_RE = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|archive)\/([^/#?]+?)(?:\.tar\.gz)?)?(?:#([^/?#]+))?(?:[/?#].*)?$/
const GITHUB_SHORT_RE = /^([\w.-]+)\/([\w.-]+)$/

/** Parse a GitHub reference; returns null for anything unrecognizable. */
export function parseGitHubSource(input: string): GitHubSource | null {
  const trimmed = input.trim()
  if (trimmed === '')
    return null
  let owner = ''
  let repo = ''
  let ref: string | undefined
  let match = GITHUB_URL_RE.exec(trimmed)
  if (match !== null) {
    // Capture order: owner, repo, /tree/<ref>, #<ref>.
    const treeRef = match[3] !== undefined ? match[3] : undefined
    const hashRef = match[4] !== undefined ? match[4] : undefined
    owner = match[1]
    repo = match[2]
    ref = treeRef ?? hashRef
  }
  else {
    match = GITHUB_SHORT_RE.exec(trimmed)
    if (match === null) {
      return null
    }
    ;[, owner, repo] = match
    ref = undefined
  }
  // `owner/repo/tree/<ref>` may URL-encode slashes in the ref — keep as-is;
  // codeload addresses refs by name, branches with slashes included.
  const decodedRef = ref !== undefined ? decodeURIComponent(ref) : undefined
  const label = `${owner}/${repo}`
  const encodedRef = decodedRef?.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const githubUrl = `https://github.com/${owner}/${repo}${encodedRef === undefined ? '' : `/tree/${encodedRef}`}`
  const tarballUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${decodedRef ?? 'HEAD'}`
  return { owner, repo, ref: decodedRef, label, githubUrl, tarballUrl }
}

/** Where skill layouts were found inside one checkout. */
export interface DetectedRoots {
  /** Scan roots to register (empty + single=false means “no skills”). */
  roots: string[]
  /** The checkout itself is one skill (SKILL.md at its root). */
  single: boolean
}

/** A plausible flat skill file: markdown with frontmatter. */
function looksLikeSkillFile(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').startsWith('---')
  }
  catch {
    return false
  }
}

/** Does one directory directly hold skills (bundle children or flat .md)? */
function holdsSkills(dir: string): boolean {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  }
  catch {
    return false
  }
  if (existsSync(join(dir, 'SKILL.md')))
    return true
  for (const name of entries) {
    if (name.endsWith('.md') && looksLikeSkillFile(join(dir, name)))
      return true
  }
  for (const name of entries) {
    const child = join(dir, name)
    try {
      if (statSync(child).isDirectory() && existsSync(join(child, 'SKILL.md')))
        return true
    }
    catch {
      // racing deletion or unreadable entry: ignore
    }
  }
  return false
}

/**
 * Find the scan roots for one checkout: the checkout itself when its
 * immediate children are skills, plus any child directory that only makes
 * sense as a collection wrapper (`skills/`, `document-skills/`, …). A
 * checkout with SKILL.md at its own root is one single skill — the caller
 * must give the provider its PARENT as the scan root.
 */
export function detectSkillRoots(checkout: string): DetectedRoots {
  if (existsSync(join(checkout, 'SKILL.md')))
    return { roots: [], single: true }
  const roots: string[] = []
  if (holdsSkills(checkout))
    roots.push(checkout)
  let entries: string[]
  try {
    entries = readdirSync(checkout)
  }
  catch {
    return { roots, single: false }
  }
  for (const name of entries) {
    if (name.startsWith('.'))
      continue
    const child = join(checkout, name)
    try {
      if (!statSync(child).isDirectory())
        continue
    }
    catch {
      continue
    }
    if (existsSync(join(child, 'SKILL.md')))
      continue // already covered by the parent root
    if (holdsSkills(child))
      roots.push(child)
  }
  return { roots, single: false }
}

/** Register a local directory as a skill repository. */
export async function addLocalRepo(path: string, dshHome?: string): Promise<SkillRootEntry> {
  const resolved = resolve(path.trim().replace(/^"|"$/g, ''))
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`not a directory: ${resolved}`)
  }
  const detected = detectSkillRoots(resolved)
  if (!detected.single && detected.roots.length === 0) {
    throw new Error('no SKILL.md found under that path (expected a skill folder or a folder of skill folders)')
  }
  if (detected.single) {
    // One skill living at the given path: the provider scans a ROOT, so wrap
    // the path in a dedicated directory holding a single link to it.
    const id = newEntryId('local')
    const material = materialDirFor(id, dshHome)
    removeTree(material)
    mkdirSync(material, { recursive: true })
    try {
      symlinkSync(resolved, join(material, 'skill'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    catch {
      removeTree(material)
      throw new Error('single-skill local folders need a directory link; try adding their parent folder instead')
    }
    return addSkillRoot({ id, kind: 'local', label: basename(resolved), path: resolved, roots: [material], materialDir: material }, dshHome)
  }
  return addSkillRoot({ id: newEntryId('local'), kind: 'local', label: basename(resolved), path: resolved, roots: detected.roots }, dshHome)
}

/** Download cap for a repo tarball. */
const TARBALL_MAX_BYTES = 256 * 1024 * 1024

/**
 * 下载仓库 tarball（二进制）：默认走 ofetch（timeout 60s、关闭重试、错误信息本地化）；
 * 传入 fetcher（测试注入原生 fetch）时保持原生语义，二者都返回 ArrayBuffer。
 */
async function downloadTarball(url: string, fetcher?: typeof fetch): Promise<ArrayBuffer> {
  if (fetcher) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok)
      throw new Error(`download failed (HTTP ${response.status}) for ${url}`)
    return response.arrayBuffer()
  }
  const response = await $fetch.raw(url, {
    responseType: 'arrayBuffer',
    timeout: 60_000,
    retry: 0,
    onResponseError: ({ response }) => {
      throw new Error(`download failed (HTTP ${response.status}) for ${url}`)
    },
  })
  return response._data as ArrayBuffer
}

/** Register a GitHub repo: tarball download → extract → detect → persist. */
export async function addGitRepo(
  url: string,
  options: { dshHome?: string, fetcher?: typeof fetch } = {},
): Promise<SkillRootEntry> {
  const source = parseGitHubSource(url)
  if (source === null)
    throw new Error('expected a GitHub repository URL or owner/repo')
  const existing = findRootByUrl(source.githubUrl, options.dshHome) ?? findRootByUrl(source.label, options.dshHome)
  if (existing !== undefined)
    throw new Error(`${source.label} is already registered`)

  const archive = Buffer.from(await downloadTarball(source.tarballUrl, options.fetcher))
  if (archive.byteLength > TARBALL_MAX_BYTES)
    throw new Error('repository tarball too large')

  const id = newEntryId('git')
  const material = materialDirFor(id, options.dshHome)
  removeTree(material)
  const checkout = join(material, 'repo')
  try {
    mkdirSync(checkout, { recursive: true })
    extractTarGz(archive, checkout, { stripComponents: 1 })
    const detected = detectSkillRoots(checkout)
    if (!detected.single && detected.roots.length === 0) {
      throw new Error('no SKILL.md found in that repository')
    }
    // A single-skill repo is discovered through the material dir itself; a
    // collection registers the checkout (plus nested collection wrappers).
    const roots = detected.single ? [material] : detected.roots
    return addSkillRoot(
      { id, kind: 'git', label: source.label, url: source.githubUrl, ref: source.ref, roots, materialDir: material },
      options.dshHome,
    )
  }
  catch (error) {
    removeTree(material)
    throw error
  }
}

/** Validate one scan root still exists; entries can go stale on disk. */
export function rootExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  }
  catch {
    return false
  }
}
