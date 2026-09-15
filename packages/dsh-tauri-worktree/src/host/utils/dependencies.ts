import { existsSync } from 'node:fs'
import { lstat, rm, symlink } from 'node:fs/promises'
import process from 'node:process'
import { filter, find, get, isEmpty, isString, map, trimEnd, uniqBy } from 'lodash-es'
import { resolve } from 'pathe'
import { DEFAULT_LINK_DIRECTORIES, INSTALL_PATTERNS, SHELL_TOOL_NAMES } from '../config/constants'

export function normalizeLinkDirectories(directories?: readonly string[]): string[] {
  const source = isEmpty(directories) ? DEFAULT_LINK_DIRECTORIES : directories ?? []
  const names = map(source, raw => trimEnd(String(raw ?? '').trim(), '/\\'))
  const valid = filter(names, name => Boolean(name) && name !== '.' && name !== '..' && !/[/\\]/.test(name))
  return uniqBy(valid, name => (process.platform === 'win32' ? name.toLowerCase() : name))
}

export function isDependencyInstallCommand(command: string): boolean {
  const text = String(command ?? '')
  return text.length > 0 && INSTALL_PATTERNS.some(pattern => pattern.test(text))
}

export function shellCommandFrom(exec: unknown): string {
  const name = get(exec, 'name')
  if (!isString(name) || !SHELL_TOOL_NAMES.has(name))
    return ''
  const args = get(exec, 'arguments')
  const value = find(['command', 'cmd', 'script'], key => isString(get(args, key)) && Boolean(get(args, key)))
  return isString(value) ? get(args, value, '') : ''
}

export function shellSessionIdFrom(exec: unknown): string {
  const sessionId = get(exec, 'agent.session.id')
  return isString(sessionId) ? sessionId : ''
}

export async function linkWorktreeDependencies(
  projectPath: string,
  worktreePath: string,
  directories: readonly string[] = DEFAULT_LINK_DIRECTORIES,
): Promise<{ linked: string[], skipped: string[] }> {
  const linked: string[] = []
  const skipped: string[] = []
  for (const name of normalizeLinkDirectories(directories)) {
    const source = resolve(projectPath, name)
    const target = resolve(worktreePath, name)
    if (!existsSync(source) || await pathExists(target)) {
      skipped.push(name)
      continue
    }
    try {
      await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(name)
    }
    catch {
      skipped.push(name)
    }
  }
  return { linked, skipped }
}

export async function unlinkWorktreeDependencies(
  worktreePath: string,
  directories: readonly string[] = DEFAULT_LINK_DIRECTORIES,
): Promise<string[]> {
  const unlinked: string[] = []
  for (const name of normalizeLinkDirectories(directories)) {
    const target = resolve(worktreePath, name)
    let stats
    try {
      stats = await lstat(target)
    }
    catch {
      continue
    }
    if (!stats.isSymbolicLink())
      continue
    try {
      await rm(target, { recursive: false, force: true })
    }
    catch {
      continue
    }
    unlinked.push(name)
  }
  return unlinked
}

// --- internal ---

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  }
  catch {
    return false
  }
}
