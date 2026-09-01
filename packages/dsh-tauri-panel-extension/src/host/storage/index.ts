/**
 * Plugin-owned state under `$DSH_HOME/dsh-tauri-panel-extension/`: the custom
 * skill repositories the user registered from the Settings page. Everything
 * the provider mounts live (local paths, extracted GitHub checkouts) hangs
 * off this file, so it stays small, JSON, and hand-recoverable.
 *
 * 适配 unstorage(fs)：读写走 dsh-tauri 的 createAtomicFsStorage（tmp+rename
 * 原子写）。同步读面（loadState）保留给路由与 provider remount 路径。
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { createAtomicFsStorage } from 'dsh-tauri'
import { join } from 'pathe'
import { PLUGIN_STATE_DIRECTORY } from '../constants/index.ts'

/** One user-registered custom skill repository. */
export interface SkillRootEntry {
  /** Stable id (used by the remove route and directory names). */
  id: string
  /** `local` — a path on this machine; `git` — extracted from a GitHub URL. */
  kind: 'local' | 'git'
  /** Display label (repo `owner/name` or the local path's basename). */
  label: string
  /** The source URL (git entries). */
  url?: string
  /** Branch/tag/ref the tarball was pulled from (git entries). */
  ref?: string
  /** Local path the user pointed at (local entries). */
  path?: string
  /** Scan roots this entry contributes (single-skill repos get a wrapper dir). */
  roots: string[]
  /** Where this entry's downloaded/junctioned material lives, if any. */
  materialDir?: string
  addedAt: number
}

/** On-disk state document. */
export interface PluginState {
  skillRoots: SkillRootEntry[]
}

/** The plugin's own directory under DSH_HOME (default `~/.dsh`). */
export function pluginStateDir(dshHome: string | undefined = process.env.DSH_HOME): string {
  return join(dshHome ?? join(homedir(), '.dsh'), PLUGIN_STATE_DIRECTORY)
}

const STATE_KEY = 'state.json'

function stateStore(dshHome?: string) {
  return createAtomicFsStorage(pluginStateDir(dshHome))
}

function emptyState(): PluginState {
  return { skillRoots: [] }
}

/** Load the state document synchronously; missing/corrupt files yield empty state. */
export function loadState(dshHome?: string): PluginState {
  try {
    const parsed = JSON.parse(readFileSync(join(pluginStateDir(dshHome), STATE_KEY), 'utf8')) as Partial<PluginState>
    if (!Array.isArray(parsed.skillRoots))
      return emptyState()
    const roots = parsed.skillRoots.filter((entry): entry is SkillRootEntry =>
      typeof entry === 'object' && entry !== null && typeof entry.id === 'string' && Array.isArray(entry.roots))
    return { skillRoots: roots }
  }
  catch {
    return emptyState()
  }
}

/** Persist by atomic rename (unstorage fs adapter) so readers never observe partial JSON. */
export async function saveState(state: PluginState, dshHome?: string): Promise<void> {
  await stateStore(dshHome).setItem(STATE_KEY, `${JSON.stringify(state, null, 2)}\n`)
}

/** New unique entry id. */
export function newEntryId(kind: 'local' | 'git'): string {
  return `${kind}-${randomBytes(4).toString('hex')}`
}

/** One entry's downloaded material (git extraction, junction wrappers). */
export function materialDirFor(entryId: string, dshHome?: string): string {
  return join(pluginStateDir(dshHome), 'repos', entryId)
}

/** Append one entry and persist. Returns the stored entry. */
export async function addSkillRoot(entry: Omit<SkillRootEntry, 'addedAt'>, dshHome?: string): Promise<SkillRootEntry> {
  const state = loadState(dshHome)
  const stored: SkillRootEntry = { ...entry, addedAt: Date.now() }
  state.skillRoots.push(stored)
  await saveState(state, dshHome)
  return stored
}

/**
 * Deregister one entry by id and persist immediately. The material dir is
 * deliberately NOT deleted here: the skill provider still watches it, and
 * removing a watched tree on Windows fails with EPERM even though the
 * state is already saved. The caller unmounts (remountProvider) first,
 * then runs removeTree over the returned entry's materialDir. Returns the
 * removed entry, or undefined when the id is unknown.
 */
export async function removeSkillRoot(id: string, dshHome?: string): Promise<SkillRootEntry | undefined> {
  const state = loadState(dshHome)
  const at = state.skillRoots.findIndex(entry => entry.id === id)
  if (at === -1)
    return undefined
  const [removed] = state.skillRoots.splice(at, 1)
  await saveState(state, dshHome)
  return removed
}

/** Find an already registered GitHub source URL (including legacy labels). */
export function findRootByUrl(url: string, dshHome?: string): SkillRootEntry | undefined {
  return loadState(dshHome).skillRoots.find(entry => entry.url === url)
}
