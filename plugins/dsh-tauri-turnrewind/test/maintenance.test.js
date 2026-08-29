import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import { workspaceHash } from '../lib/core/git-snapshot.js'
import { createOperation, getTurn, insertTurn, openLedger, queueRewindNotice, registerWorkspace, settleTurn } from '../lib/core/ledger.js'
import { purgeWorkspace } from '../lib/core/maintenance.js'

it('purges ledger rows and the snapshot repository for one workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-purge-test-'))
  const workspace = join(root, 'ws')
  const workspaceKey = resolve(workspace).toLowerCase()
  try {
    const db = openLedger(root)
    registerWorkspace(db, workspaceKey, workspace, join(root, 'snapshots', 'x.git'))
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey,
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/turn-session-1-before',
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/turn-session-1-after')
    createOperation(db, {
      operationId: 'op-1',
      kind: 'undo',
      targetTurnId: 'session:1',
      requestedAt: '2026-01-01T00:01:00.000Z',
    })
    queueRewindNotice(db, {
      noticeId: 'notice-1',
      sessionId: 'session',
      workspaceKey,
      targetTurnId: 'session:1',
      paths: ['a.txt'],
      createdAt: '2026-01-01T00:01:00.000Z',
    })
    db.close()

    const repoDir = join(root, 'snapshots', `${workspaceHash(workspace)}.git`)
    await mkdir(join(repoDir, 'objects'), { recursive: true })
    await writeFile(join(repoDir, 'HEAD'), 'ref: refs/heads/main\n')

    const summary = purgeWorkspace(root, workspace)
    assert.equal(summary.repoExisted, true)
    assert.deepEqual(summary.ledger, { operations: 1, notices: 1, turns: 1, workspaces: 1 })
    assert.equal(existsSync(repoDir), false)

    const verify = openLedger(root)
    try {
      assert.equal(getTurn(verify, 'session:1'), undefined)
      assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM operations').get().count, 0)
      assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM rewind_notices').get().count, 0)
      assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM workspaces').get().count, 0)
    }
    finally {
      verify.close()
    }

    const repeat = purgeWorkspace(root, workspace)
    assert.equal(repeat.repoExisted, false)
    assert.deepEqual(repeat.ledger, { operations: 0, notices: 0, turns: 0, workspaces: 0 })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
