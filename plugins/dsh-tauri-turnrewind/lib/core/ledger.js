import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS workspaces (
    workspace_key TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    snapshot_repo TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_turn_id TEXT,
    workspace_key TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    settled_at TEXT,
    before_ref TEXT,
    after_ref TEXT,
    reversible INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id, started_at);
  CREATE INDEX IF NOT EXISTS turns_parent_idx ON turns(parent_turn_id);
  CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_turn_id TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    settled_at TEXT,
    outcome TEXT NOT NULL,
    before_ref TEXT,
    after_ref TEXT,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS rewind_notices (
    notice_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    target_turn_id TEXT NOT NULL,
    paths_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    claimed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS rewind_notices_session_idx ON rewind_notices(session_id, status, created_at);
`

export function openLedger(rootDir) {
  const path = join(rootDir, 'ledger.sqlite')
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  // Older local prototypes may already have the table; add the new recovery column idempotently.
  try {
    db.exec('ALTER TABLE operations ADD COLUMN after_ref TEXT')
  }
  catch {
    // Column already exists.
  }
  db.exec(`UPDATE turns SET status = 'abandoned', reversible = 0, error = 'plugin restarted during active turn' WHERE status = 'active'`)
  return db
}

export function registerWorkspace(db, workspaceKey, workspacePath, snapshotRepo) {
  db.prepare(`
    INSERT INTO workspaces(workspace_key, workspace_path, snapshot_repo, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_key) DO UPDATE SET workspace_path = excluded.workspace_path, snapshot_repo = excluded.snapshot_repo
  `).run(workspaceKey, workspacePath, snapshotRepo, new Date().toISOString())
}

export function insertTurn(db, turn) {
  db.prepare(`
    INSERT INTO turns(turn_id, session_id, parent_turn_id, workspace_key, status, started_at, before_ref, reversible)
    VALUES (?, ?, ?, ?, 'active', ?, ?, 1)
  `).run(turn.turnId, turn.sessionId, turn.parentTurnId ?? null, turn.workspaceKey, turn.startedAt, turn.beforeRef)
}

export function settleTurn(db, turnId, afterRef) {
  db.prepare(`UPDATE turns SET status = 'settled', settled_at = ?, after_ref = ?, reversible = 1 WHERE turn_id = ?`)
    .run(new Date().toISOString(), afterRef, turnId)
}

export function settleNoopTurn(db, turnId, afterRef) {
  db.prepare(`UPDATE turns SET status = 'settled', settled_at = ?, after_ref = ?, reversible = 0, error = ? WHERE turn_id = ?`)
    .run(new Date().toISOString(), afterRef, 'no file changes', turnId)
}

export function failTurn(db, turnId, error) {
  db.prepare(`UPDATE turns SET status = 'failed', settled_at = ?, reversible = 0, error = ? WHERE turn_id = ?`)
    .run(new Date().toISOString(), String(error), turnId)
}

export function getTurn(db, turnId) {
  return db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId)
}

export function getLatestTurn(db, sessionId, workspaceKey) {
  return db.prepare(`
    SELECT * FROM turns
    WHERE session_id = ? AND workspace_key = ? AND status = 'settled' AND reversible = 1
    ORDER BY started_at DESC LIMIT 1
  `).get(sessionId, workspaceKey)
}

export function getLatestSnapshotRef(db, workspaceKey) {
  return db.prepare(`
    SELECT after_ref FROM turns
    WHERE workspace_key = ? AND after_ref IS NOT NULL
    ORDER BY settled_at DESC LIMIT 1
  `).get(workspaceKey)?.after_ref
}

export function listChildren(db, parentTurnId) {
  return db.prepare(`SELECT * FROM turns WHERE parent_turn_id = ? ORDER BY started_at ASC`).all(parentTurnId)
}

export function createOperation(db, operation) {
  db.prepare(`
    INSERT INTO operations(operation_id, kind, target_turn_id, requested_at, outcome, before_ref)
    VALUES (?, ?, ?, ?, 'applying', ?)
  `).run(operation.operationId, operation.kind, operation.targetTurnId, operation.requestedAt, operation.beforeRef ?? null)
}

export function settleOperation(db, operationId, outcome, error) {
  db.prepare(`UPDATE operations SET settled_at = ?, outcome = ?, error = ? WHERE operation_id = ?`)
    .run(new Date().toISOString(), outcome, error ? String(error) : null, operationId)
}

export function queueRewindNotice(db, notice) {
  db.prepare(`
    UPDATE rewind_notices SET status = 'superseded'
    WHERE session_id = ? AND workspace_key = ? AND status = 'pending'
  `).run(notice.sessionId, notice.workspaceKey)
  db.prepare(`
    INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, paths_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    notice.noticeId,
    notice.sessionId,
    notice.workspaceKey,
    notice.targetTurnId,
    JSON.stringify(notice.paths),
    notice.createdAt,
  )
}

export function claimRewindNotice(db, sessionId, workspaceKey) {
  const notice = db.prepare(`
    SELECT * FROM rewind_notices
    WHERE session_id = ? AND workspace_key = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `).get(sessionId, workspaceKey)
  if (!notice)
    return undefined
  const result = db.prepare(`
    UPDATE rewind_notices SET status = 'consumed', claimed_at = ?
    WHERE notice_id = ? AND status = 'pending'
  `).run(new Date().toISOString(), notice.notice_id)
  if (result.changes !== 1)
    return undefined
  return {
    ...notice,
    paths: JSON.parse(notice.paths_json),
  }
}

export function completeUndoWithNotice(db, turnId, notice) {
  db.exec('BEGIN')
  try {
    db.prepare(`UPDATE turns SET status = 'undone' WHERE turn_id = ?`).run(turnId)
    db.prepare(`
      UPDATE rewind_notices SET status = 'superseded'
      WHERE session_id = ? AND workspace_key = ? AND status = 'pending'
    `).run(notice.sessionId, notice.workspaceKey)
    db.prepare(`
      INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, paths_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      notice.noticeId,
      notice.sessionId,
      notice.workspaceKey,
      notice.targetTurnId,
      JSON.stringify(notice.paths),
      notice.createdAt,
    )
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
