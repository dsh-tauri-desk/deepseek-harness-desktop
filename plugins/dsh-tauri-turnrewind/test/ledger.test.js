import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { claimRewindNotice, completeUndoWithNotice, getLatestSnapshotRef, getLatestTurn, getTurn, insertTurn, openLedger, queueRewindNotice, settleNoopTurn, settleTurn } from '../lib/core/ledger.js'

it('persists turn lifecycle and resumes from the latest durable snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-ledger-test-'))
  const db = openLedger(root)
  try {
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/turn-session-1-before',
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/turn-session-1-after')
    assert.equal(getTurn(db, 'session:1').status, 'settled')
    assert.equal(getLatestTurn(db, 'session', 'workspace').turn_id, 'session:1')
    assert.equal(getLatestSnapshotRef(db, 'workspace'), 'refs/turnrewind/turn-session-1-after')

    insertTurn(db, {
      turnId: 'session:2',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:01:00.000Z',
      beforeRef: 'refs/turnrewind/turn-session-2-before',
    })
    settleNoopTurn(db, 'session:2', 'refs/turnrewind/turn-session-2-after')
    assert.equal(getLatestTurn(db, 'session', 'workspace').turn_id, 'session:1')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('marks undo and queues its one-time notice atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-undo-notice-test-'))
  const db = openLedger(root)
  try {
    insertTurn(db, {
      turnId: 'session:undo',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/undo-before',
    })
    settleTurn(db, 'session:undo', 'refs/turnrewind/undo-after')
    completeUndoWithNotice(db, 'session:undo', {
      noticeId: 'notice-undo',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:undo',
      paths: ['src/reverted.ts'],
      createdAt: '2026-01-01T00:01:00.000Z',
    })
    assert.equal(getTurn(db, 'session:undo').status, 'undone')
    const notice = claimRewindNotice(db, 'session', 'workspace')
    assert.equal(notice.notice_id, 'notice-undo')
    assert.deepEqual(notice.paths, ['src/reverted.ts'])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('delivers only the latest pending rewind notice once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-notice-test-'))
  const db = openLedger(root)
  try {
    queueRewindNotice(db, {
      noticeId: 'notice-one',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:1',
      paths: ['src/old.ts'],
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    queueRewindNotice(db, {
      noticeId: 'notice-two',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:2',
      paths: ['src/new.ts'],
      createdAt: '2026-01-01T00:01:00.000Z',
    })
    const notice = claimRewindNotice(db, 'session', 'workspace')
    assert.equal(notice.notice_id, 'notice-two')
    assert.deepEqual(notice.paths, ['src/new.ts'])
    assert.equal(claimRewindNotice(db, 'session', 'workspace'), undefined)
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('marks an interrupted active turn abandoned on reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-recovery-test-'))
  const first = openLedger(root)
  insertTurn(first, {
    turnId: 'session:active',
    sessionId: 'session',
    workspaceKey: 'workspace',
    startedAt: '2026-01-01T00:00:00.000Z',
    beforeRef: 'refs/turnrewind/active-before',
  })
  first.close()
  const reopened = openLedger(root)
  try {
    assert.equal(getTurn(reopened, 'session:active').status, 'abandoned')
    assert.equal(getTurn(reopened, 'session:active').reversible, 0)
  }
  finally {
    reopened.close()
    await rm(root, { recursive: true, force: true })
  }
})
