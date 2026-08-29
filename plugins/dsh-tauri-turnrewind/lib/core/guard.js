import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { MAX_FILE_BYTES } from './git-snapshot.js'

const DEFAULT_MAX_FILES = 50_000
const DEFAULT_MAX_TOTAL_BYTES = 1024 ** 3

// Mirror the directory part of the snapshot excludes so the guard measures what
// `git add` would actually ingest instead of the raw tree.
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.turnrewind'])

const OVERSIZED_SAMPLE_LIMIT = 5

function envCount(name, fallback) {
  const raw = process.env[name]
  if (!raw)
    return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function normalizeDir(path) {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  }
  catch {
    // Missing or unreadable paths still need a deterministic comparison key.
    return resolved
  }
}

function foldCase(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function defaultBudget() {
  return {
    maxFiles: envCount('TURNREWIND_MAX_FILES', DEFAULT_MAX_FILES),
    maxTotalBytes: envCount('TURNREWIND_MAX_BYTES', DEFAULT_MAX_TOTAL_BYTES),
    maxFileBytes: MAX_FILE_BYTES,
  }
}

export function isSystemSensitiveWorkspace(workspaceDir) {
  const workspace = foldCase(normalizeDir(workspaceDir))
  const home = foldCase(normalizeDir(homedir()))
  if (workspace === home)
    return true
  // An ancestor of the home directory would snapshot every user profile
  // including the DSH data dir itself, so refuse it alongside the home dir.
  if (home.startsWith(`${workspace}${sep}`))
    return true
  return parse(workspace).root === workspace
}

class BudgetAbort extends Error {}

/**
 * Metadata-only walk that aborts as soon as a budget is exceeded, so even a
 * 250 GB home directory costs at most one bounded scan instead of a full
 * `git add` baseline.
 */
export function scanWithinBudget(workspaceDir, budget = defaultBudget()) {
  const root = resolve(workspaceDir)
  const state = { files: 0, bytes: 0, oversized: [] }

  const visit = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    }
    catch {
      // Subtrees that cannot be listed are equally unusable for snapshots.
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name))
          visit(join(dir, entry.name))
        continue
      }
      // Symlinks and junctions are never followed, mirroring restorePath.
      if (!entry.isFile())
        continue
      const path = join(dir, entry.name)
      const info = lstatSync(path, { throwIfNoEntry: false })
      if (!info)
        continue
      state.files += 1
      state.bytes += info.size
      if (info.size > budget.maxFileBytes && state.oversized.length < OVERSIZED_SAMPLE_LIMIT)
        state.oversized.push(relative(root, path))
      if (state.files > budget.maxFiles || state.bytes > budget.maxTotalBytes)
        throw new BudgetAbort()
    }
  }

  try {
    visit(root)
  }
  catch (error) {
    if (!(error instanceof BudgetAbort))
      throw error
  }

  const reason = state.files > budget.maxFiles
    ? `file count ${state.files} exceeds the limit ${budget.maxFiles}`
    : state.bytes > budget.maxTotalBytes
      ? `total size ${state.bytes} bytes exceeds the limit ${budget.maxTotalBytes}`
      : state.oversized.length > 0
        ? `files larger than ${budget.maxFileBytes} bytes can never be restored: ${state.oversized.join(', ')}`
        : undefined
  return {
    files: state.files,
    bytes: state.bytes,
    oversized: state.oversized,
    ok: reason === undefined,
    reason,
  }
}

export function assessWorkspace(workspaceDir) {
  const workspace = resolve(workspaceDir)
  if (isSystemSensitiveWorkspace(workspace)) {
    return {
      eligible: false,
      reason: `TURNREWIND_WORKSPACE_UNSUPPORTED: ${workspace} is a system directory (the home directory, one of its ancestors, or a drive root)`,
    }
  }
  const scan = scanWithinBudget(workspace)
  if (!scan.ok) {
    return {
      eligible: false,
      reason: `TURNREWIND_WORKSPACE_TOO_LARGE: ${workspace} exceeds the snapshot budget (${scan.reason})`,
    }
  }
  return { eligible: true, files: scan.files, bytes: scan.bytes }
}
