import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { workspaceHash } from './git-snapshot.js'
import { openLedger } from './ledger.js'

export function resolveRootDir(explicit) {
  if (explicit)
    return resolve(explicit)
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}

/**
 * Remove every piece of turnrewind data bound to one workspace: the private
 * snapshot repository on disk and all ledger rows that reference it. Used to
 * recover from workspaces that were snapshotted before the eligibility guard
 * existed (for example a 250 GB home directory).
 */
export function purgeWorkspace(rootDir, workspaceDir) {
  const workspaceKey = resolve(workspaceDir).toLowerCase()
  const repoDir = join(rootDir, 'snapshots', `${workspaceHash(workspaceDir)}.git`)
  const summary = { rootDir, repoDir, repoExisted: false, ledger: undefined }

  const ledgerPath = join(rootDir, 'ledger.sqlite')
  if (existsSync(ledgerPath)) {
    const db = openLedger(rootDir)
    try {
      db.exec('BEGIN')
      const operations = db.prepare('DELETE FROM operations WHERE target_turn_id IN (SELECT turn_id FROM turns WHERE workspace_key = ?)').run(workspaceKey)
      const notices = db.prepare('DELETE FROM rewind_notices WHERE workspace_key = ?').run(workspaceKey)
      const turns = db.prepare('DELETE FROM turns WHERE workspace_key = ?').run(workspaceKey)
      const workspaces = db.prepare('DELETE FROM workspaces WHERE workspace_key = ?').run(workspaceKey)
      db.exec('COMMIT')
      summary.ledger = {
        operations: operations.changes,
        notices: notices.changes,
        turns: turns.changes,
        workspaces: workspaces.changes,
      }
    }
    finally {
      db.close()
    }
  }

  summary.repoExisted = existsSync(repoDir)
  rmSync(repoDir, { recursive: true, force: true })
  return summary
}
