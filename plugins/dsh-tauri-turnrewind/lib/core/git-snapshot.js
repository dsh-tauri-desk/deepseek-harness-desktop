import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const EXCLUDE_PATHS = [
  ':(exclude,glob).git/**',
  ':(exclude,glob)**/.git/**',
  ':(exclude,glob)node_modules/**',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)dist/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)build/**',
  ':(exclude,glob)**/build/**',
  ':(exclude,glob)coverage/**',
  ':(exclude,glob)**/coverage/**',
  ':(exclude,glob).turnrewind/**',
  ':(exclude,glob)**/.turnrewind/**',
  ':(exclude,glob).env',
  ':(exclude,glob)**/.env',
  ':(exclude,glob).env.*',
  ':(exclude,glob)**/.env.*',
  ':(exclude,glob)**/*.pem',
  ':(exclude,glob)**/*.key',
  ':(exclude,glob)id_rsa*',
  ':(exclude,glob)**/id_rsa*',
  ':(exclude,glob)credentials*',
  ':(exclude,glob)**/credentials*',
  ':(exclude,glob)*secret*',
  ':(exclude,glob)**/*secret*',
  ':(exclude,glob)*token*',
  ':(exclude,glob)**/*token*',
]

function runGit(repoDir, workspaceDir, args, extraEnv = {}) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', '--git-dir', repoDir, '--work-tree', workspaceDir, ...args], {
    cwd: workspaceDir,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error)
    throw new Error(`TURNREWIND_GIT_EXEC: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`TURNREWIND_GIT_FAILED: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`)
  }
  return result.stdout
}

function ensureRepository(repoDir, workspaceDir) {
  if (!existsSync(join(repoDir, 'HEAD'))) {
    mkdirSync(dirname(repoDir), { recursive: true })
    const result = spawnSync('git', ['init', '--bare', repoDir], { encoding: 'utf8' })
    if (result.error || result.status !== 0) {
      throw new Error(`TURNREWIND_GIT_INIT: ${result.stderr?.trim() || result.error?.message || 'git init failed'}`)
    }
  }
  runGit(repoDir, workspaceDir, ['config', 'core.bare', 'false'])
  runGit(repoDir, workspaceDir, ['config', 'core.worktree', workspaceDir])
}

function gitRef(repoDir, workspaceDir, ref) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', '--git-dir', repoDir, 'rev-parse', '--verify', ref], {
    cwd: workspaceDir,
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function assertSafePath(workspaceDir, path) {
  const root = resolve(workspaceDir)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`TURNREWIND_PATH_ESCAPE: ${path}`)
  }

  let current = root
  const suffix = relative(root, target)
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`TURNREWIND_SYMLINK_UNSUPPORTED: ${path}`)
    }
  }
  return target
}

function snapshotPathspecs() {
  return EXCLUDE_PATHS
}

export function workspaceHash(workspaceDir) {
  const normalized = resolve(workspaceDir)
  const identity = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

export function createSnapshotStore(rootDir, workspaceDir) {
  const normalizedWorkspace = resolve(workspaceDir)
  const repoDir = join(rootDir, 'snapshots', `${workspaceHash(normalizedWorkspace)}.git`)
  ensureRepository(repoDir, normalizedWorkspace)
  return { repoDir, workspaceDir: normalizedWorkspace }
}

/** Capture a complete allowed-path tree, incrementally reusing the parent tree. */
export function captureSnapshot(store, refName, message, parentRef) {
  const { repoDir, workspaceDir } = store
  ensureRepository(repoDir, workspaceDir)
  const indexPath = join(repoDir, `turnrewind-index-${randomUUID()}`)
  try {
    const env = { GIT_INDEX_FILE: indexPath }
    if (parentRef)
      runGit(repoDir, workspaceDir, ['read-tree', parentRef], env)
    runGit(repoDir, workspaceDir, ['add', '--all', '--', '.', ...snapshotPathspecs()], env)
    const tree = runGit(repoDir, workspaceDir, ['write-tree'], env).trim()
    const identity = {
      GIT_AUTHOR_NAME: 'DSH Turn Rewind',
      GIT_AUTHOR_EMAIL: 'turnrewind@localhost',
      GIT_COMMITTER_NAME: 'DSH Turn Rewind',
      GIT_COMMITTER_EMAIL: 'turnrewind@localhost',
    }
    const args = ['commit-tree', tree, '-m', message]
    if (parentRef)
      args.push('-p', parentRef)
    const commit = runGit(repoDir, workspaceDir, args, { ...env, ...identity }).trim()
    runGit(repoDir, workspaceDir, ['update-ref', refName, commit])
    return { commit, refName }
  }
  finally {
    rmSync(indexPath, { force: true })
  }
}

export function snapshotDiff(store, beforeCommit, afterCommit) {
  const output = runGit(store.repoDir, store.workspaceDir, ['diff', '--name-only', '--no-renames', beforeCommit, afterCommit])
  return [...new Set(output.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
}

function commitEntry(store, commit, path) {
  const output = runGit(store.repoDir, store.workspaceDir, ['ls-tree', '-r', '--name-only', commit, '--', path])
  return output.split(/\r?\n/).includes(path)
}

function commitBytes(store, commit, path) {
  const result = spawnSync('git', ['--git-dir', store.repoDir, 'show', `${commit}:${path}`], {
    cwd: store.workspaceDir,
    encoding: null,
    maxBuffer: MAX_FILE_BYTES,
  })
  if (result.error)
    throw new Error(`TURNREWIND_GIT_READ: ${path}: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(`TURNREWIND_GIT_READ: ${path}`)
  if (result.stdout.length > MAX_FILE_BYTES)
    throw new Error(`TURNREWIND_FILE_TOO_LARGE: ${path}`)
  return result.stdout
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function stateAt(store, commit, path) {
  if (!commitEntry(store, commit, path))
    return { kind: 'absent', digest: null }
  const bytes = commitBytes(store, commit, path)
  return { kind: 'file', digest: digest(bytes) }
}

export function currentState(workspaceDir, path) {
  const target = assertSafePath(workspaceDir, path)
  if (!existsSync(target))
    return { kind: 'absent', digest: null }
  const info = lstatSync(target)
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    return { kind: 'unsupported', digest: null }
  return { kind: 'file', digest: digest(readFileSync(target)) }
}

export function restorePath(store, commit, path) {
  const target = assertSafePath(store.workspaceDir, path)
  if (!commitEntry(store, commit, path)) {
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`)
      rmSync(target, { recursive: info.isDirectory(), force: true })
    }
    return { path, result: 'removed' }
  }

  const bytes = commitBytes(store, commit, path)
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.turnrewind-${randomUUID()}.tmp`
  writeFileSync(temp, bytes, { flag: 'wx' })
  try {
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`)
      rmSync(target, { force: true })
    }
    renameSync(temp, target)
  }
  catch (error) {
    rmSync(temp, { force: true })
    throw new Error(`TURNREWIND_RESTORE_FAILED: ${path}: ${error.message}`)
  }
  return { path, result: 'restored' }
}

export function pathIsSafe(workspaceDir, path) {
  try {
    assertSafePath(workspaceDir, path)
    return true
  }
  catch {
    return false
  }
}

export { gitRef, MAX_FILE_BYTES }
