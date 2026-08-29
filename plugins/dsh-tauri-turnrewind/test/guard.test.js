import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { afterEach, it } from 'vitest'
import { assessWorkspace, isSystemSensitiveWorkspace, scanWithinBudget } from '../lib/core/guard.js'

const LARGE_BUDGET = { maxFiles: 50_000, maxTotalBytes: 1024 ** 3, maxFileBytes: 64 * 1024 * 1024 }

afterEach(() => {
  delete process.env.TURNREWIND_MAX_FILES
  delete process.env.TURNREWIND_MAX_BYTES
})

it('refuses the home directory, its ancestors, and drive roots', () => {
  assert.equal(isSystemSensitiveWorkspace(homedir()), true)
  assert.equal(isSystemSensitiveWorkspace(dirname(homedir())), true)
  assert.equal(isSystemSensitiveWorkspace(parse(homedir()).root), true)
  assert.equal(isSystemSensitiveWorkspace(parse(tmpdir()).root), true)
})

it('accepts an ordinary small workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-guard-ok-'))
  try {
    await writeFile(join(root, 'a.txt'), 'a')
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested', 'b.txt'), 'b')
    const assessment = assessWorkspace(root)
    assert.equal(assessment.eligible, true)
    assert.equal(assessment.files, 2)
    assert.equal(assessment.bytes, 2)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses workspaces over the file-count budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-guard-files-'))
  try {
    await mkdir(join(root, 'd'), { recursive: true })
    for (let index = 0; index < 5; index += 1)
      await writeFile(join(root, 'd', `f${index}.txt`), 'x')
    const scan = scanWithinBudget(root, { ...LARGE_BUDGET, maxFiles: 3 })
    assert.equal(scan.ok, false)
    assert.match(scan.reason, /file count/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses workspaces over the total-size budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-guard-bytes-'))
  try {
    await writeFile(join(root, 'big.bin'), '0123456789'.repeat(10))
    const scan = scanWithinBudget(root, { ...LARGE_BUDGET, maxTotalBytes: 50 })
    assert.equal(scan.ok, false)
    assert.match(scan.reason, /total size/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses files that could never be restored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-guard-big-'))
  try {
    await writeFile(join(root, 'huge.bin'), '0123456789ABCDEF')
    const scan = scanWithinBudget(root, { ...LARGE_BUDGET, maxFileBytes: 10 })
    assert.equal(scan.ok, false)
    assert.match(scan.reason, /larger than 10 bytes/)
    assert.deepEqual(scan.oversized, ['huge.bin'])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('ignores excluded directories when measuring the budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-guard-skip-'))
  try {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    for (let index = 0; index < 10; index += 1) {
      await writeFile(join(root, 'node_modules', 'pkg', `f${index}.txt`), 'x')
      await writeFile(join(root, '.git', `obj${index}`), 'x')
    }
    const scan = scanWithinBudget(root, { ...LARGE_BUDGET, maxFiles: 5 })
    assert.equal(scan.ok, true)
    assert.equal(scan.files, 0)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('honors TURNREWIND_MAX_FILES via assessWorkspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-guard-env-'))
  try {
    for (let index = 0; index < 3; index += 1)
      await writeFile(join(root, `f${index}.txt`), 'x')
    process.env.TURNREWIND_MAX_FILES = '2'
    const assessment = assessWorkspace(root)
    assert.equal(assessment.eligible, false)
    assert.match(assessment.reason, /TURNREWIND_WORKSPACE_TOO_LARGE/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
