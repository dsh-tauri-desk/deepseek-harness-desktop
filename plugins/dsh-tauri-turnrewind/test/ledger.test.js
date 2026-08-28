import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { claimRewindNotices, completeUndoWithNotice, getLatestSnapshotRef, getLatestTurn, getTurn, insertTurn, openLedger, queueRewindNotice, settleInterruptedTurn, settleNoopTurn, settleTurn } from '../lib/core/ledger.js'

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
    const notices = claimRewindNotices(db, 'session', 'workspace')
    assert.equal(notices.length, 1)
    assert.equal(notices[0].notice_id, 'notice-undo')
    assert.deepEqual(notices[0].paths, ['src/reverted.ts'])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('merges multiple pending rewind notices and delivers them once', async () => {
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
    const notices = claimRewindNotices(db, 'session', 'workspace')
    assert.equal(notices.length, 2)
    assert.deepEqual(notices.map(notice => notice.notice_id), ['notice-one', 'notice-two'])
    assert.deepEqual(notices.map(notice => notice.turns), [['session:1'], ['session:2']])
    assert.deepEqual(notices.map(notice => notice.paths), [['src/old.ts'], ['src/new.ts']])
    assert.deepEqual(claimRewindNotices(db, 'session', 'workspace'), [])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('merges a C-B-A undo sequence into one complete notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-cba-test-'))
  const db = openLedger(root)
  try {
    for (const [turnId, time] of [
      ['session:A', '2026-01-01T00:00:00.000Z'],
      ['session:B', '2026-01-01T00:01:00.000Z'],
      ['session:C', '2026-01-01T00:02:00.000Z'],
    ]) {
      insertTurn(db, {
        turnId,
        sessionId: 'session',
        workspaceKey: 'workspace',
        startedAt: time,
        beforeRef: `${turnId}-before`,
      })
      settleTurn(db, turnId, `${turnId}-after`)
    }
    for (const [turnId, path, time] of [
      ['session:C', 'c.ts', '2026-01-01T00:03:00.000Z'],
      ['session:B', 'b.ts', '2026-01-01T00:04:00.000Z'],
      ['session:A', 'a.ts', '2026-01-01T00:05:00.000Z'],
    ]) {
      completeUndoWithNotice(db, turnId, {
        noticeId: `notice-${turnId}`,
        sessionId: 'session',
        workspaceKey: 'workspace',
        targetTurnId: turnId,
        paths: [path],
        createdAt: time,
      })
    }
    const notices = claimRewindNotices(db, 'session', 'workspace')
    assert.deepEqual(notices.map(notice => notice.turns), [['session:C'], ['session:B'], ['session:A']])
    assert.deepEqual(notices.map(notice => notice.paths), [['c.ts'], ['b.ts'], ['a.ts']])
    assert.deepEqual(claimRewindNotices(db, 'session', 'workspace'), [])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps an interrupted turn reversible when it captured file changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-interrupt-test-'))
  const db = openLedger(root)
  try {
    insertTurn(db, {
      turnId: 'session:settled',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/settled-before',
    })
    settleTurn(db, 'session:settled', 'refs/turnrewind/settled-after')
    insertTurn(db, {
      turnId: 'session:interrupted',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:01:00.000Z',
      beforeRef: 'refs/turnrewind/interrupted-before',
    })
    settleInterruptedTurn(
      db,
      'session:interrupted',
      'refs/turnrewind/interrupted-after',
      'agent became idle after interruption',
    )
    assert.equal(getTurn(db, 'session:interrupted').status, 'interrupted')
    assert.equal(getTurn(db, 'session:interrupted').reversible, 1)
    assert.equal(getLatestTurn(db, 'session', 'workspace').turn_id, 'session:interrupted')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('selects an interrupted turn after a later turn is undone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-sequence-test-'))
  const db = openLedger(root)
  try {
    insertTurn(db, {
      turnId: 'session:interrupted',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/interrupted-before',
    })
    settleInterruptedTurn(db, 'session:interrupted', 'refs/turnrewind/interrupted-after', 'interrupted')
    insertTurn(db, {
      turnId: 'session:later',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:01:00.000Z',
      beforeRef: 'refs/turnrewind/later-before',
    })
    settleTurn(db, 'session:later', 'refs/turnrewind/later-after')
    completeUndoWithNotice(db, 'session:later', {
      noticeId: 'notice-later',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:later',
      paths: ['later.txt'],
      createdAt: '2026-01-01T00:02:00.000Z',
    })
    assert.equal(getLatestTurn(db, 'session', 'workspace').turn_id, 'session:interrupted')
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
