/**
 * Plugin-owned archive persistence under `$DSH_HOME/dsh-tauri-session/`.
 * The archive is deliberately plugin-owned (not the host workspace archive set):
 * the host `WorkspaceRegistry` exposes `archiveSession` but no way to remove a
 * session from its archive set, so un-archiving cannot go through it. Keeping
 * our own set + never touching workspace accounting lets us un-archive back to
 * the original group without depending on host APIs that do not exist.
 */

import type { ArchiveDocument } from './types.js'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { SESSION_ARCHIVE_FILE, SESSION_STATE_DIRECTORY } from './constants.js'

/** The plugin's own state directory under DSH_HOME (default `~/.dsh`). */
export function sessionStateDir(dshHome?: string): string {
  return join(dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), SESSION_STATE_DIRECTORY)
}

function archivePath(dshHome?: string): string {
  return join(sessionStateDir(dshHome), SESSION_ARCHIVE_FILE)
}

/** Fresh empty archive document. */
export function emptyArchive(): ArchiveDocument {
  return {}
}

/** Load the archive; missing/corrupt files yield an empty archive. */
export function loadArchive(dshHome?: string): ArchiveDocument {
  const path = archivePath(dshHome)
  if (!existsSync(path))
    return emptyArchive()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return emptyArchive()
    const out: ArchiveDocument = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Partial<{ sessionId: string, archivedAt: number }>
      if (typeof key === 'string' && typeof record?.sessionId === 'string' && key === record.sessionId)
        out[key] = record as ArchiveDocument[string]
    }
    return out
  }
  catch {
    return emptyArchive()
  }
}

/** Persist by atomic rename so readers never observe partial JSON. */
export function saveArchive(archive: ArchiveDocument, dshHome?: string): void {
  const dir = sessionStateDir(dshHome)
  const target = archivePath(dshHome)
  const temporary = join(dir, `.archive-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(temporary, `${JSON.stringify(archive, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  }
  finally {
    rmSync(temporary, { force: true })
  }
}
