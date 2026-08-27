import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, currentState, stateAt } from '../lib/core/git-snapshot.js'

it('does not capture common secret files into a snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-secret-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, '.env'), 'TOKEN=do-not-store')
    await writeFile(join(workspace, 'credentials.json'), '{"token":"do-not-store"}')
    await writeFile(join(workspace, 'safe.txt'), 'safe')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = captureSnapshot(store, 'refs/turnrewind/security', 'security')

    assert.equal(stateAt(store, snapshot.commit, '.env').kind, 'absent')
    assert.equal(stateAt(store, snapshot.commit, 'credentials.json').kind, 'absent')
    assert.equal(stateAt(store, snapshot.commit, 'safe.txt').kind, 'file')
    const snapshotFiles = await readdir(join(root, 'data', 'snapshots'))
    assert.equal(snapshotFiles.length, 1)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('does not follow a symlinked workspace path during state inspection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-symlink-test-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'outside')
    try {
      await symlink(outside, join(workspace, 'linked'))
    }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES')
        return
      throw error
    }
    const store = createSnapshotStore(join(root, 'data'), workspace)
    assert.throws(() => currentState(workspace, 'linked/secret.txt'), /TURNREWIND_SYMLINK_UNSUPPORTED/)
    assert.throws(() => stateAt(store, captureSnapshot(store, 'refs/turnrewind/symlink', 'symlink').commit, 'linked/secret.txt'), /TURNREWIND_SYMLINK_UNSUPPORTED/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
