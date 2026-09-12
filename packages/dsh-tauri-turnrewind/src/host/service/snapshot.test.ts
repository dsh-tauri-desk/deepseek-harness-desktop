import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { gitInSnapshot } from './git'
import {
  captureSnapshot,
  conflictPaths,
  diffTurnChanges,
  liveDiff,
  readGenerationFor,
  readRefCommit,
  resolveInsideWorkspace,
  restoreTurnChanges,
  scanNestedRepos,
  snapshotStoreFor,
  turnRef,
} from './snapshot'

const run = promisify(execFile)

const temporaryDirectories: string[] = []

async function fixture(): Promise<{ dshHome: string, worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-turnrewind-snapshot-'))
  temporaryDirectories.push(root)
  const dshHome = join(root, 'home')
  const worktree = join(root, 'project')
  await mkdir(dshHome, { recursive: true })
  await mkdir(worktree, { recursive: true })
  await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', worktree], { windowsHide: true })
  await writeFile(join(worktree, 'a.txt'), 'one\ntwo\n', 'utf8')
  await writeFile(join(worktree, 'gone.txt'), 'bye\n', 'utf8')
  await writeFile(join(worktree, '.gitignore'), 'ignored.txt\n', 'utf8')
  await writeFile(join(worktree, 'ignored.txt'), 'never tracked\n', 'utf8')
  return { dshHome, worktree }
}

async function gitStatus(worktree: string): Promise<string> {
  const { stdout } = await run('git', ['-C', worktree, 'status', '--porcelain=v1'], { windowsHide: true })
  return stdout
}

async function gitHead(worktree: string): Promise<string> {
  const [head, branch, refs] = await Promise.all([
    run('git', ['-C', worktree, 'rev-parse', 'HEAD'], { windowsHide: true }).catch(() => ({ stdout: '' })),
    run('git', ['-C', worktree, 'symbolic-ref', '--quiet', 'HEAD'], { windowsHide: true }).catch(() => ({ stdout: '' })),
    run('git', ['-C', worktree, 'for-each-ref', '--format=%(refname)'], { windowsHide: true }),
  ])
  return `${head.stdout}|${branch.stdout}|${refs.stdout}`
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('captureSnapshot + diffTurnChanges', () => {
  it('reports added / modified / deleted files with per-file line counts', async () => {
    const { dshHome, worktree } = await fixture()
    const store = snapshotStoreFor(dshHome, worktree)

    const before = await captureSnapshot(store, turnRef('s1', 1, 'before'), 'turn 1 before')
    expect(before.ok).toBe(true)

    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await writeFile(join(worktree, 'new.txt'), 'fresh\n', 'utf8')
    await rm(join(worktree, 'gone.txt'))

    const after = await captureSnapshot(store, turnRef('s1', 1, 'after'), 'turn 1 after')
    expect(after.ok).toBe(true)
    if (!before.ok || !after.ok)
      return

    const diff = await diffTurnChanges(store, before.commit, after.commit)
    expect(diff.ok).toBe(true)
    if (!diff.ok)
      return
    const byPath = new Map(diff.changes.map(change => [change.path, change]))
    expect(byPath.get('a.txt')).toMatchObject({ status: 'M', insertions: 1, deletions: 0, binary: false })
    expect(byPath.get('new.txt')).toMatchObject({ status: 'A', insertions: 1, deletions: 0 })
    expect(byPath.get('gone.txt')).toMatchObject({ status: 'D' })
    // 被 .gitignore 排除的文件由源仓库 ignore 规则决定，不进入快照。
    expect(byPath.has('ignored.txt')).toBe(false)
  })

  it('marks binary differences instead of counting lines', async () => {
    const { dshHome, worktree } = await fixture()
    const store = snapshotStoreFor(dshHome, worktree)
    const before = await captureSnapshot(store, turnRef('s2', 1, 'before'), 'before')
    expect(before.ok).toBe(true)
    await writeFile(join(worktree, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    const after = await captureSnapshot(store, turnRef('s2', 1, 'after'), 'after')
    expect(after.ok).toBe(true)
    if (!before.ok || !after.ok)
      return
    const diff = await diffTurnChanges(store, before.commit, after.commit)
    expect(diff.ok).toBe(true)
    if (!diff.ok)
      return
    expect(diff.changes.find(change => change.path === 'blob.bin')).toMatchObject({ binary: true, insertions: null, deletions: null })
  })

  it('keeps the user repository untouched (HEAD / branch / refs / status)', async () => {
    const { dshHome, worktree } = await fixture()
    const beforeState = await gitHead(worktree)
    const beforeStatus = await gitStatus(worktree)
    const store = snapshotStoreFor(dshHome, worktree)
    await captureSnapshot(store, turnRef('s3', 1, 'before'), 'before')
    await writeFile(join(worktree, 'a.txt'), 'changed\n', 'utf8')
    await captureSnapshot(store, turnRef('s3', 1, 'after'), 'after')
    expect(await gitHead(worktree)).toBe(beforeState)
    expect(await gitStatus(worktree)).toBe(beforeStatus)
  })
})

describe('conflictPaths', () => {
  it('flags files changed after the turn and clears untouched ones', async () => {
    const { dshHome, worktree } = await fixture()
    const store = snapshotStoreFor(dshHome, worktree)
    const before = await captureSnapshot(store, turnRef('s4', 1, 'before'), 'before')
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await writeFile(join(worktree, 'made.txt'), 'made\n', 'utf8')
    const after = await captureSnapshot(store, turnRef('s4', 1, 'after'), 'after')
    expect(before.ok && after.ok).toBe(true)
    if (!before.ok || !after.ok)
      return
    const diff = await diffTurnChanges(store, before.commit, after.commit)
    expect(diff.ok).toBe(true)
    if (!diff.ok)
      return

    const clean = await conflictPaths(store, after.commit, diff.changes)
    expect(clean).toEqual({ ok: true, paths: [] })

    await writeFile(join(worktree, 'a.txt'), 'user edited again\n', 'utf8')
    const conflicted = await conflictPaths(store, after.commit, diff.changes)
    expect(conflicted.ok).toBe(true)
    if (conflicted.ok)
      expect(conflicted.paths).toEqual(['a.txt'])
  })

  it('flags a recreated file the turn had deleted (git diff alone cannot see it)', async () => {
    const { dshHome, worktree } = await fixture()
    const store = snapshotStoreFor(dshHome, worktree)
    const before = await captureSnapshot(store, turnRef('s5', 1, 'before'), 'before')
    await rm(join(worktree, 'gone.txt'))
    const after = await captureSnapshot(store, turnRef('s5', 1, 'after'), 'after')
    expect(before.ok && after.ok).toBe(true)
    if (!before.ok || !after.ok)
      return
    const diff = await diffTurnChanges(store, before.commit, after.commit)
    expect(diff.ok).toBe(true)
    if (!diff.ok)
      return
    await writeFile(join(worktree, 'gone.txt'), 'user recreated it\n', 'utf8')
    const conflicted = await conflictPaths(store, after.commit, diff.changes)
    expect(conflicted.ok).toBe(true)
    if (conflicted.ok)
      expect(conflicted.paths).toContain('gone.txt')
  })
})

describe('restoreTurnChanges', () => {
  it('restores modified and deleted files and removes files the turn created', async () => {
    const { dshHome, worktree } = await fixture()
    const store = snapshotStoreFor(dshHome, worktree)
    const before = await captureSnapshot(store, turnRef('s6', 1, 'before'), 'before')
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await rm(join(worktree, 'gone.txt'))
    await mkdir(join(worktree, 'fresh', 'deep'), { recursive: true })
    await writeFile(join(worktree, 'fresh', 'deep', 'new.txt'), 'new\n', 'utf8')
    const after = await captureSnapshot(store, turnRef('s6', 1, 'after'), 'after')
    expect(before.ok && after.ok).toBe(true)
    if (!before.ok || !after.ok)
      return
    const diff = await diffTurnChanges(store, before.commit, after.commit)
    expect(diff.ok).toBe(true)
    if (!diff.ok)
      return

    const report = await restoreTurnChanges(store, before.commit, diff.changes)
    expect(report.failed).toEqual([])
    // 换行由 git 的 filter 决定（私有仓镜像源仓库/全局 core.autocrlf），
    // 断言时先归一：真正要钉的是「内容回到 before」，不是某一种换行字节。
    const restored = await readFile(join(worktree, 'a.txt'), 'utf8')
    expect(restored.replace(/\r\n/g, '\n')).toBe('one\ntwo\n')
    expect((await readFile(join(worktree, 'gone.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('bye\n')
    expect(existsSync(join(worktree, 'fresh', 'deep', 'new.txt'))).toBe(false)
    // 只清理变空的父目录，工作区根本身保留。
    expect(existsSync(join(worktree, 'fresh', 'deep'))).toBe(false)
    expect(existsSync(worktree)).toBe(true)

    // 恢复后的工作区必须与 before 快照**逐字节等价**（同一 git 树）：
    // 这条同时钉住换行/属性的往返对称性——若私有仓的 core.autocrlf 与源仓库
    // 不一致，恢复出来的树就会与 before 树不同，此断言立刻失败。
    const recheck = await captureSnapshot(store, turnRef('s6-recheck', 1, 'before'), 'recheck')
    expect(recheck.ok).toBe(true)
    if (recheck.ok && before.ok) {
      const [beforeTree, recheckTree] = await Promise.all([
        gitInSnapshot(store, ['rev-parse', `${before.commit}^{tree}`]),
        gitInSnapshot(store, ['rev-parse', `${recheck.commit}^{tree}`]),
      ])
      expect(beforeTree.ok && recheckTree.ok).toBe(true)
      if (beforeTree.ok && recheckTree.ok)
        expect(recheckTree.out.trim()).toBe(beforeTree.out.trim())
    }
  })
})

describe('liveDiff（运行中实时读数）', () => {
  it('counts the workspace against the before snapshot, including brand-new files', async () => {
    const { dshHome, worktree } = await fixture()
    const store = snapshotStoreFor(dshHome, worktree)
    const before = await captureSnapshot(store, turnRef('s7', 1, 'before'), 'before')
    expect(before.ok).toBe(true)
    if (!before.ok)
      return

    // turn 刚起步：还没有任何改动。
    expect(await liveDiff(store, before.commit)).toEqual({ ok: true, stats: { fileCount: 0, insertions: 0, deletions: 0 } })

    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await writeFile(join(worktree, 'added.txt'), 'new\n', 'utf8')
    await rm(join(worktree, 'gone.txt'))

    const live = await liveDiff(store, before.commit)
    expect(live.ok).toBe(true)
    if (!live.ok)
      return
    // 修改 + 新建 + 删除各算一个文件；新建文件靠「先刷新私有 index」才可见。
    expect(live.stats).toEqual({ fileCount: 3, insertions: 2, deletions: 1 })

    // 实时读数只是「提前看」：结束后的 after 差异必须给出同一组文件。
    const after = await captureSnapshot(store, turnRef('s7', 1, 'after'), 'after')
    expect(after.ok).toBe(true)
    if (!after.ok)
      return
    const diff = await diffTurnChanges(store, before.commit, after.commit)
    expect(diff.ok).toBe(true)
    if (!diff.ok)
      return
    expect(diff.changes).toHaveLength(live.stats.fileCount)
  })

  it('reports git failures instead of throwing when the snapshot store is gone', async () => {
    const { dshHome, worktree } = await fixture()
    const store = snapshotStoreFor(dshHome, worktree)
    const before = await captureSnapshot(store, turnRef('s8', 1, 'before'), 'before')
    expect(before.ok).toBe(true)
    if (!before.ok)
      return
    await rm(store.gitDir, { recursive: true, force: true })
    const live = await liveDiff(store, before.commit)
    expect(live.ok).toBe(false)
  })

  it('把嵌套仓库目录传给 `nestedDirs` 后，它们不会被算成本轮新增的文件', async () => {
    // 回归背景：`source/react-use`、`source/vueuse` 这类**被跟踪的**嵌套仓库不是
    // 「被忽略的参考克隆」：不含嵌套目录的排除清单时，这里的 `git add --all` 会把它们
    // 作为 gitlink 写进私有 index，而 before 快照（捕获时已排除）里没有这些条目 ——
    // `git diff <before>` 于是报出两条 `1 0` 的「新增文件」：工作区一个字节都没动，
    // 提示条却显示「2 个文件已更改 +2 -0」（用户实际反馈，仓库里恰有两个嵌套仓库）。
    const { dshHome, worktree } = await fixture()
    const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=test']
    for (const name of ['react-use', 'vueuse']) {
      const nested = join(worktree, 'source', name)
      await mkdir(nested, { recursive: true })
      await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', nested], { windowsHide: true })
      await writeFile(join(nested, 'inner.txt'), 'v1\n', 'utf8')
      await run('git', ['-C', nested, ...identity, 'add', '--all'], { windowsHide: true })
      await run('git', ['-C', nested, ...identity, 'commit', '--quiet', '-m', 'init'], { windowsHide: true })
      // 源仓库把它登记成 gitlink：与真实仓库里被跟踪的 submodule 同形态。
      await run('git', ['-C', worktree, ...identity, 'add', `source/${name}`], { windowsHide: true })
    }

    const store = snapshotStoreFor(dshHome, worktree)
    const nestedDirs = scanNestedRepos(worktree)
    // `scanNestedRepos` 按 `readdirSync` 的顺序追加（不排序），枚举顺序随文件系统而变
    // （Linux 上就不是字典序），断言前先排序，别把文件系统行为钉进期望值。
    expect([...nestedDirs].sort()).toEqual(['source/react-use', 'source/vueuse'])
    const before = await captureSnapshot(store, turnRef('s16', 1, 'before'), 'before', { nestedDirs })
    expect(before.ok).toBe(true)
    if (!before.ok)
      return

    // 没有任何改动：读数必须是空的，私有 index 里也不能留下这两个 gitlink。
    const live = await liveDiff(store, before.commit, { nestedDirs })
    expect(live).toEqual({ ok: true, stats: { fileCount: 0, insertions: 0, deletions: 0 } })
    const listed = await gitInSnapshot(store, ['ls-files', '--', 'source'])
    expect(listed.ok).toBe(true)
    if (listed.ok)
      expect(listed.out.trim()).toBe('')

    // 嵌套仓库内部提交前进（gitlink 指针变化）同样不算这一轮的改动：
    // 它的内容本来就不在撤销范围内，提示条不该为它报数。
    const advanced = join(worktree, 'source', 'react-use')
    await writeFile(join(advanced, 'inner.txt'), 'v2\n', 'utf8')
    await run('git', ['-C', advanced, ...identity, 'add', '--all'], { windowsHide: true })
    await run('git', ['-C', advanced, ...identity, 'commit', '--quiet', '-m', 'advance'], { windowsHide: true })
    expect(await liveDiff(store, before.commit, { nestedDirs })).toEqual({ ok: true, stats: { fileCount: 0, insertions: 0, deletions: 0 } })

    // 真正的改动照常计入（排除不是把整棵树都静音了）。
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    expect(await liveDiff(store, before.commit, { nestedDirs })).toEqual({ ok: true, stats: { fileCount: 1, insertions: 1, deletions: 0 } })
  })
})

describe('捕获限额（超限文件 / 嵌套仓库）', () => {
  it('超限时排除最大的文件后重试，并把它记进跳过明细', async () => {
    const { dshHome, worktree } = await fixture()
    const store = snapshotStoreFor(dshHome, worktree)
    await writeFile(join(worktree, 'small.txt'), 'ok\n', 'utf8')
    await writeFile(join(worktree, 'big.bin'), Buffer.alloc(4096, 7))

    // 用一个极小上限触发真实上限（64MB / 512MB）在测试里造不出来的路径。
    const captured = await captureSnapshot(store, turnRef('s9', 1, 'before'), 'before', {
      limits: { maxFileBytes: 64, maxSnapshotBytes: 64, maxFiles: 100 },
    })
    expect(captured.ok).toBe(true)
    if (!captured.ok)
      return

    expect(captured.skippedOversized).toContain('big.bin')
    expect(captured.learnedExclusions).toContain('big.bin')
    // 排除是「真的没进快照」：ls-tree 里不能有它。
    const listed = await gitInSnapshot(store, ['ls-tree', '-r', '--name-only', captured.commit])
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.out).not.toContain('big.bin')
      expect(listed.out).toContain('small.txt')
    }

    // 学到的排除清单要能传给下一次捕获：这样后续 turn 不必再付一次重捕代价。
    const again = await captureSnapshot(store, turnRef('s9', 1, 'after'), 'after', {
      exclude: captured.learnedExclusions,
      limits: { maxFileBytes: 64, maxSnapshotBytes: 64, maxFiles: 100 },
    })
    expect(again.ok).toBe(true)
    if (again.ok)
      expect(again.skippedOversized).toContain('big.bin')
  })

  it('自动跳过嵌套仓库（有提交 → gitlink，撤销无法保护其内容）', async () => {
    const { dshHome, worktree } = await fixture()
    const nested = join(worktree, 'nested')
    await mkdir(nested, { recursive: true })
    await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', nested], { windowsHide: true })
    await writeFile(join(nested, 'inner.txt'), 'v1\n', 'utf8')
    const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=test']
    await run('git', ['-C', nested, ...identity, 'add', '--all'], { windowsHide: true })
    await run('git', ['-C', nested, ...identity, 'commit', '--quiet', '-m', 'init'], { windowsHide: true })

    const store = snapshotStoreFor(dshHome, worktree)
    const before = await captureSnapshot(store, turnRef('s10', 1, 'before'), 'before')
    expect(before.ok).toBe(true)

    // 嵌套仓库内部改动：若不排除，diff 只会显示 `M nested`（gitlink 指针变化）——
    // 那是一条**假**的撤销能力：`git checkout` 会成功但嵌套目录内容纹丝不动。
    await writeFile(join(nested, 'inner.txt'), 'v2 changed\n', 'utf8')
    const after = await captureSnapshot(store, turnRef('s10', 1, 'after'), 'after')
    expect(after.ok).toBe(true)
    if (!before.ok || !after.ok)
      return
    expect(after.skippedNestedRepos).toContain('nested')

    const diff = await diffTurnChanges(store, before.commit, after.commit)
    expect(diff.ok).toBe(true)
    if (diff.ok)
      expect(diff.changes.filter(change => change.path === 'nested' || change.path.startsWith('nested/'))).toEqual([])
  })

  it('预扫没发现时，靠 git add 的报错兜底识别无提交的嵌套仓库', async () => {
    const { dshHome, worktree } = await fixture()
    const nested = join(worktree, 'nested')
    await mkdir(nested, { recursive: true })
    await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', nested], { windowsHide: true })
    await writeFile(join(nested, 'inner.txt'), 'uncommitted\n', 'utf8')

    const store = snapshotStoreFor(dshHome, worktree)
    // 显式传空 nestedDirs：模拟预扫被跳过/漏判时 `git add --all` 直接 fatal
    // （"does not have a commit checked out"）的兜底路径。
    const captured = await captureSnapshot(store, turnRef('s11', 1, 'before'), 'before', { nestedDirs: [] })
    expect(captured.ok).toBe(true)
    if (!captured.ok)
      return
    expect(captured.skippedNestedRepos).toContain('nested')
    expect(captured.learnedExclusions).toContain('nested')
  })
})

describe('被 .gitignore 忽略的排除路径', () => {
  /**
   * 复刻真实仓库的形态：整棵「参考源码」目录被忽略，未跟踪的克隆就放在里面
   * （本仓库的 `source/` 正是如此——`.gitignore` 忽略整个 `source/`）。
   */
  async function ignoredNestedFixture(): Promise<{ dshHome: string, worktree: string, nestedDirs: string[] }> {
    const { dshHome, worktree } = await fixture()
    await writeFile(join(worktree, '.gitignore'), 'ignored.txt\nvendor/\n', 'utf8')
    const nested = join(worktree, 'vendor', 'clone')
    await mkdir(nested, { recursive: true })
    await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', nested], { windowsHide: true })
    await writeFile(join(nested, 'inner.txt'), 'inner\n', 'utf8')
    return { dshHome, worktree, nestedDirs: scanNestedRepos(worktree) }
  }

  it('捕获不会因为 exclude pathspec 指向被忽略的目录而整体失败', async () => {
    // 回归背景：`git add --all -- . :(exclude)vendor/clone` 会以
    // “The following paths are ignored by one of your .gitignore files” 退出（exit 1）。
    // 变更前这里返回 TURNREWIND_SNAPSHOT_FAILED，于是该工作区**每一轮**都被记成
    // 「撤销不可用」并弹告警卡片——哪怕用户什么都没改（用户实际报告的现象）。
    const { dshHome, worktree, nestedDirs } = await ignoredNestedFixture()
    expect(nestedDirs).toEqual(['vendor/clone'])
    const store = snapshotStoreFor(dshHome, worktree)

    const before = await captureSnapshot(store, turnRef('s13', 1, 'before'), 'before', { nestedDirs })
    expect(before.ok).toBe(true)
    if (!before.ok)
      return
    // 被忽略的嵌套目录仍然如实上报：撤销确实不会碰它。
    expect(before.skippedNestedRepos).toContain('vendor/clone')

    // 排除清单从磁盘回来（后续 turn 的常路：`entry.exclusions`）时同样不能炸。
    const after = await captureSnapshot(store, turnRef('s13', 1, 'after'), 'after', { nestedDirs, exclude: nestedDirs })
    expect(after.ok).toBe(true)
    if (!after.ok)
      return
    // 没有任何改动 → 差异为空，客户端因此不渲染任何卡片。
    const diff = await diffTurnChanges(store, before.commit, after.commit)
    expect(diff.ok).toBe(true)
    if (diff.ok)
      expect(diff.changes).toEqual([])
  })

  it('运行中实时读数同样不受影响（否则提示条永远不出现）', async () => {
    const { dshHome, worktree, nestedDirs } = await ignoredNestedFixture()
    const store = snapshotStoreFor(dshHome, worktree)
    const before = await captureSnapshot(store, turnRef('s14', 1, 'before'), 'before', { nestedDirs })
    expect(before.ok).toBe(true)
    if (!before.ok)
      return
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    const live = await liveDiff(store, before.commit, { exclude: nestedDirs })
    expect(live.ok).toBe(true)
    if (live.ok)
      expect(live.stats).toEqual({ fileCount: 1, insertions: 1, deletions: 0 })
  })

  it('已经被捕获过、之后才进入排除清单的路径不会混进运行中实时读数', async () => {
    // 回归背景：`git add` 不会更新被排除路径的既有 index 条目，而 `git diff <commit>`
    // 不带 pathspec 时照样按 index 条目把它的改动算进来——实时读数于是比最终结算多出
    // 这些文件（与「排除清单要带上」的注释意图不符）。CodeRabbit 复核指出，已在实测复现。
    const { dshHome, worktree } = await fixture()
    const store = snapshotStoreFor(dshHome, worktree)
    await mkdir(join(worktree, 'vendor'), { recursive: true })
    await writeFile(join(worktree, 'vendor', 'file.txt'), 'before\n', 'utf8')

    // 第一轮：vendor/ 还没被排除 → 正常进快照（也就进了私有 index）。
    const before = await captureSnapshot(store, turnRef('s15', 1, 'before'), 'before')
    expect(before.ok).toBe(true)
    if (!before.ok)
      return

    // 之后它才进入排除清单（学到的嵌套仓库 / 超限文件同理会这样），并发生改动。
    await writeFile(join(worktree, 'vendor', 'file.txt'), 'after\n', 'utf8')
    const listed = await gitInSnapshot(store, ['ls-files', '--', 'vendor/file.txt'])
    expect(listed.ok && listed.out.includes('vendor/file.txt')).toBe(true)

    const live = await liveDiff(store, before.commit, { exclude: ['vendor'] })
    expect(live.ok).toBe(true)
    if (live.ok)
      expect(live.stats).toEqual({ fileCount: 0, insertions: 0, deletions: 0 })
  })
})

describe('快照仓代数', () => {
  it('首次初始化分配代数；仓库被删后重建会轮换代数（旧记录据此过期）', async () => {
    const { dshHome, worktree } = await fixture()
    const store = snapshotStoreFor(dshHome, worktree)
    expect(store.generation).toBeUndefined()

    const first = await captureSnapshot(store, turnRef('s12', 1, 'before'), 'before')
    expect(first.ok).toBe(true)
    const firstGeneration = store.generation
    expect(firstGeneration).toBeTypeOf('string')
    expect(await readGenerationFor(dshHome, worktree)).toBe(firstGeneration)

    // 整仓消失（被隔离重建 / 用户清理）：下一次捕获必须换一代。
    await rm(store.gitDir, { recursive: true, force: true })
    const second = await captureSnapshot(store, turnRef('s12', 1, 'after'), 'after')
    expect(second.ok).toBe(true)
    expect(store.generation).toBeTypeOf('string')
    expect(store.generation).not.toBe(firstGeneration)
    expect(await readGenerationFor(dshHome, worktree)).toBe(store.generation)
    // 老 ref 随旧仓一起消失：旧代数记录不存在「指向别人对象」的错乱。
    expect(await readRefCommit(store, turnRef('s12', 1, 'before'))).toBeNull()
  })
})

describe('resolveInsideWorkspace', () => {
  it('accepts nested paths and rejects escapes', async () => {
    const { worktree } = await fixture()
    expect(resolveInsideWorkspace(worktree, 'src/a.ts')).not.toBeNull()
    expect(resolveInsideWorkspace(worktree, '../outside.txt')).toBeNull()
    expect(resolveInsideWorkspace(worktree, 'a/../../outside.txt')).toBeNull()
    expect(resolveInsideWorkspace(worktree, 'C:\\Other\\file.txt')).toBeNull()
    expect(resolveInsideWorkspace(worktree, '')).toBeNull()
  })
})
