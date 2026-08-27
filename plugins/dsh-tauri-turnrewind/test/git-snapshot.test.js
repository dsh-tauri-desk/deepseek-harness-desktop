import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, currentState, restorePath, snapshotDiff, stateAt } from '../lib/core/git-snapshot.js'

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
