import type { GitOptions, OperationResult } from '../types'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { compact, get, partition } from 'lodash-es'
import { basename, join, resolve } from 'pathe'
import { simpleGit } from 'simple-git'

export async function git(args: string[], cwd: string, options: GitOptions = {}): Promise<OperationResult<{ out: string }>> {
  try {
    const client = simpleGit({
      baseDir: cwd,
      abort: options.signal,
      ...(options.timeout === undefined ? {} : { timeout: { block: options.timeout } }),
      spawnOptions: { windowsHide: true } as unknown as { uid?: number, gid?: number },
      trimmed: true,
    })
    return { ok: true, out: await client.raw(args) }
  }
  catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export async function stagedPatch(cwd: string, options: GitOptions = {}): Promise<OperationResult<{ patch: string }>> {
  const result = await git(['diff', '--cached', '--binary', '--no-renames'], cwd, options)
  return result.ok ? { ok: true, patch: result.out } : result
}

export async function applyStagedPatch(cwd: string, patch: string, options: GitOptions = {}): Promise<OperationResult<{ out: string }>> {
  if (!patch.trim())
    return { ok: true, out: '' }
  const applied = await applyPatchArchive(cwd, patch, options)
  if (!applied.ok)
    return applied

  const names = await git(['diff', '--cached', '--name-only', '-z'], cwd, options)
  if (!names.ok)
    return names
  const paths = compact(names.out.split('\0'))
  if (paths.length === 0)
    return { ok: true, out: '' }

  const trackedRaw = await git(['ls-files', '-z', '--', ...paths], cwd, options)
  if (!trackedRaw.ok)
    return trackedRaw
  const tracked = new Set(compact(trackedRaw.out.split('\0')))
  const [inIndex, deleted] = partition(paths, path => tracked.has(path))
  if (inIndex.length > 0) {
    const written = await git(['checkout-index', '-f', '--', ...inIndex], cwd, options)
    if (!written.ok)
      return written
  }
  for (const relative of deleted)
    await rm(join(cwd, relative), { force: true }).catch(() => {})
  return { ok: true, out: paths.join('\n') }
}

export async function carryStagedChanges(sourceCwd: string, targetCwd: string, options: GitOptions = {}): Promise<OperationResult<{ carried: string[] }>> {
  const captured = await stagedPatch(sourceCwd, options)
  if (!captured.ok)
    return captured
  if (!captured.patch.trim())
    return { ok: true, carried: [] }
  const applied = await applyStagedPatch(targetCwd, captured.patch, options)
  if (!applied.ok)
    return applied
  return { ok: true, carried: compact(applied.out.split('\n')) }
}

export async function gitToplevel(path: string): Promise<string | null> {
  const result = await git(['rev-parse', '--show-toplevel'], path)
  return result.ok ? resolve(result.out) : null
}

export function projectDirname(projectPath: string): string {
  return basename(resolve(projectPath))
}

export async function shortHead(worktreePath: string): Promise<string> {
  const result = await git(['rev-parse', '--short', 'HEAD'], worktreePath)
  return result.ok ? result.out : '?'
}

export async function headSubject(worktreePath: string): Promise<string> {
  const result = await git(['log', '-1', '--pretty=%s'], worktreePath)
  return result.ok && result.out ? result.out : '?'
}

// --- internal ---

function errorMessage(error: unknown): string {
  return String(get(error, 'stderr') ?? get(error, 'message') ?? error).trim()
}

async function applyPatchArchive(cwd: string, patch: string, options: GitOptions = {}): Promise<OperationResult<{ out: string }>> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'dsh-worktree-'))
    const patchPath = join(dir, 'staged.patch')
    await writeFile(patchPath, patch.endsWith('\n') ? patch : `${patch}\n`, 'utf8')
    return await git(['apply', '--cached', '--binary', '--whitespace=nowarn', patchPath], cwd, options)
  }
  catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  finally {
    if (dir)
      await rm(dir, { recursive: true, force: true })
  }
}
