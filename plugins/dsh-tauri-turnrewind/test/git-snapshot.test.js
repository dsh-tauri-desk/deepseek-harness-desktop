import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, currentState, restorePath, snapshotDiff, stateAt } from '../lib/core/git-snapshot.js'
import { completeUndoWithNotice, getLatestTurn, insertTurn, openLedger, settleInterruptedTurn, settleTurn } from '../lib/core/ledger.js'

it('captures and restores modified, added, and deleted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'modified.txt'), 'before')
    await writeFile(join(workspace, 'deleted.txt'), 'to delete')

    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = captureSnapshot(store, 'refs/turnrewind/test-before', 'before')

    await writeFile(join(workspace, 'modified.txt'), 'after')
    await rm(join(workspace, 'deleted.txt'))
    await writeFile(join(workspace, 'added.txt'), 'new')
    const after = captureSnapshot(store, 'refs/turnrewind/test-after', 'after', before.commit)

    assert.deepEqual(snapshotDiff(store, before.commit, after.commit).sort(), ['added.txt', 'deleted.txt', 'modified.txt'])
    assert.notEqual(stateAt(store, before.commit, 'modified.txt').digest, stateAt(store, after.commit, 'modified.txt').digest)

    restorePath(store, before.commit, 'modified.txt')
    restorePath(store, before.commit, 'deleted.txt')
    restorePath(store, before.commit, 'added.txt')

    assert.equal(await readFile(join(workspace, 'modified.txt'), 'utf8'), 'before')
    assert.equal(await readFile(join(workspace, 'deleted.txt'), 'utf8'), 'to delete')
    await assert.rejects(stat(join(workspace, 'added.txt')))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('allows sequential undo of an interrupted turn after a later turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-sequence-test-'))
  const workspace = join(root, 'workspace')
  const filesA = ['a-1.txt', 'a-2.txt']
  const filesB = ['b-1.txt', 'b-2.txt']
  const db = openLedger(join(root, 'ledger'))
  try {
    await mkdir(workspace, { recursive: true })
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const beforeA = captureSnapshot(store, 'refs/turnrewind/a-before', 'A before')
    for (const file of filesA) await writeFile(join(workspace, file), 'A')
    const afterA = captureSnapshot(store, 'refs/turnrewind/a-after', 'A after', beforeA.commit)
    insertTurn(db, {
      turnId: 'session:A',
      sessionId: 'session',
      workspaceKey: workspace.toLowerCase(),
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/a-before',
    })
    settleInterruptedTurn(db, 'session:A', 'refs/turnrewind/a-after', 'interrupted')

    const beforeB = captureSnapshot(store, 'refs/turnrewind/b-before', 'B before', afterA.commit)
    for (const file of filesB) await writeFile(join(workspace, file), 'B')
    const afterB = captureSnapshot(store, 'refs/turnrewind/b-after', 'B after', beforeB.commit)
    insertTurn(db, {
      turnId: 'session:B',
      sessionId: 'session',
      workspaceKey: workspace.toLowerCase(),
      startedAt: '2026-01-01T00:01:00.000Z',
      beforeRef: 'refs/turnrewind/b-before',
    })
    settleTurn(db, 'session:B', 'refs/turnrewind/b-after')

    for (const file of snapshotDiff(store, beforeB.commit, afterB.commit)) restorePath(store, beforeB.commit, file)
    completeUndoWithNotice(db, 'session:B', {
      noticeId: 'notice-b',
      sessionId: 'session',
      workspaceKey: workspace.toLowerCase(),
      targetTurnId: 'session:B',
      paths: filesB,
      createdAt: '2026-01-01T00:02:00.000Z',
    })
    assert.equal(getLatestTurn(db, 'session', workspace.toLowerCase()).turn_id, 'session:A')

    for (const file of snapshotDiff(store, beforeA.commit, afterA.commit)) restorePath(store, beforeA.commit, file)
    for (const file of [...filesA, ...filesB]) await assert.rejects(stat(join(workspace, file)))
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('handles non-ASCII paths without reporting a false restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-unicode-test-'))
  const workspace = join(root, 'workspace')
  const fileName = '新建文本文档.txt'
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, fileName), 'before')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = captureSnapshot(store, 'refs/turnrewind/unicode-before', 'before')
    await writeFile(join(workspace, fileName), 'after')
    const after = captureSnapshot(store, 'refs/turnrewind/unicode-after', 'after', before.commit)
    assert.deepEqual(snapshotDiff(store, before.commit, after.commit), [fileName])
    restorePath(store, before.commit, fileName)
    assert.equal(await readFile(join(workspace, fileName), 'utf8'), 'before')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('does not treat CRLF conversion as a file conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-crlf-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'line-endings.txt'), 'before\nline\n')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = captureSnapshot(store, 'refs/turnrewind/crlf-before', 'before')
    await writeFile(join(workspace, 'line-endings.txt'), 'after\nline\n')
    const after = captureSnapshot(store, 'refs/turnrewind/crlf-after', 'after', before.commit)
    await writeFile(join(workspace, 'line-endings.txt'), 'after\r\nline\r\n')
    assert.equal(currentState(workspace, 'line-endings.txt').digest, stateAt(store, after.commit, 'line-endings.txt').digest)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects paths outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-path-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    assert.throws(() => currentState(workspace, '../outside.txt'), /TURNREWIND_PATH_ESCAPE/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
