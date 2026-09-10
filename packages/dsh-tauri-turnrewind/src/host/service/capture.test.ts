import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { createTurnCapture } from './capture'
import { readLedger } from './ledger'
import { createWorkspaceQueue } from './queue'

const run = promisify(execFile)

const temporaryDirectories: string[] = []

async function fixture(): Promise<{ dshHome: string, worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-turnrewind-capture-'))
  temporaryDirectories.push(root)
  const dshHome = join(root, 'home')
  const worktree = join(root, 'project')
  await mkdir(dshHome, { recursive: true })
  await mkdir(worktree, { recursive: true })
  await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', worktree], { windowsHide: true })
  await writeFile(join(worktree, 'a.txt'), 'one\ntwo\n', 'utf8')
  return { dshHome, worktree }
}

/** 本次用例建过的捕获编排器（收尾要卸载，否则实时轮询会一直持有临时目录）。 */
const captures: Array<ReturnType<typeof createTurnCapture>> = []

function captureFor(dshHome: string, captured: number[] = []) {
  const capture = createTurnCapture({
    dshHome,
    queue: createWorkspaceQueue(),
    onCaptured: (_sessionId, _turn, fileCount) => captured.push(fileCount),
  })
  captures.push(capture)
  return capture
}

afterEach(async () => {
  // 卸载捕获编排器：实时轮询的定时器与在飞的 git 子进程都会握着工作区，
  // Windows 上直接 rmdir 会 EBUSY。先停表、再给子进程一点退出时间。
  for (const capture of captures.splice(0))
    capture.dispose()
  await new Promise(resolve => setTimeout(resolve, 100))
  for (const path of temporaryDirectories.splice(0)) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(path, { recursive: true, force: true })
        break
      }
      catch (error) {
        // 在飞的 git 子进程把工作区当 cwd：有界重试后如实抛出，不静默留垃圾。
        if (attempt >= 4)
          throw error
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
  }
})

describe('turn 结算编排', () => {
  it('正常一轮：before → 改动 → 结算，账本记录本轮改动（卡片据此渲染）', async () => {
    const { dshHome, worktree } = await fixture()
    const capture = captureFor(dshHome)

    await capture.beginTurn('s5', 1, worktree)
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await capture.settleTurn('s5', 1)

    const ledger = await readLedger(dshHome, 's5')
    expect(ledger.turns).toHaveLength(1)
    expect(ledger.turns[0]?.unavailable ?? null).toBeNull()
    expect(ledger.turns[0]?.files.map(file => file.path)).toEqual(['a.txt'])
  })

  it('turn/end 落在 before 快照还在飞的时候，这一轮仍然会被结算', async () => {
    const { dshHome, worktree } = await fixture()
    const capture = captureFor(dshHome)

    // 用户手动停止就发生在这个窗口里：`agent/pre-step` 的屏障还没回来（before 快照在跑
    // `git add`），而 `turn/end` 已经到达。变更前这种 turn 会**整个消失**——账本里没有行，
    // 直到很久以后某个 idle 才被顺手收掉（实测有 30 分钟后才落账的）。
    const beginning = capture.beginTurn('s1', 1, worktree)
    await capture.settleTurn('s1', 1)
    await beginning

    const ledger = await readLedger(dshHome, 's1')
    expect(ledger.turns.map(turn => turn.turn)).toEqual([1])
    // 基线留下了（refs 非空）：后续任何地方都能据此判定撤销是否可用。
    expect(ledger.turns[0]?.beforeRef.length).toBeGreaterThan(0)
    expect(ledger.turns[0]?.afterRef.length).toBeGreaterThan(0)
  })

  it('agent/status → idle 早于 before 快照落地时同样不丢（手动中断的常路）', async () => {
    const { dshHome, worktree } = await fixture()
    const capture = captureFor(dshHome)

    const beginning = capture.beginTurn('s2', 1, worktree)
    await capture.settleIdle('s2')
    await beginning

    expect((await readLedger(dshHome, 's2')).turns.map(turn => turn.turn)).toEqual([1])
  })

  it('turn/end 与 idle 同时到达也只结算一次', async () => {
    const { dshHome, worktree } = await fixture()
    const captured: number[] = []
    const capture = captureFor(dshHome, captured)

    const beginning = capture.beginTurn('s3', 1, worktree)
    await Promise.all([capture.settleTurn('s3', 1), capture.settleIdle('s3')])
    await beginning

    // 重复结算会重复捕 after、重复触发 onCaptured 钩子，账本行也会被后写的那次覆盖。
    expect(captured).toEqual([0])
    expect((await readLedger(dshHome, 's3')).turns).toHaveLength(1)
  })

  it('idle 兜底只结算「idle 那一刻已在跑」的 turn，不碰随后新开始的一轮', async () => {
    const { dshHome, worktree } = await fixture()
    const capture = captureFor(dshHome)

    const first = capture.beginTurn('s6', 1, worktree)
    const idle = capture.settleIdle('s6')
    // idle 之后（用户重新发消息）立刻开始的新一轮：这次兜底不能把它一起结算掉，
    // 否则它的 after 会在 before 刚结束时被拍下来，那一轮的真实改动就永远拿不到了。
    const second = capture.beginTurn('s6', 2, worktree)
    await Promise.all([first, second, idle])

    expect((await readLedger(dshHome, 's6')).turns.map(turn => turn.turn)).toEqual([1])
  })

  it('根本没有 before 快照的 turn 不会被凭空记一笔', async () => {
    const { dshHome } = await fixture()
    const capture = captureFor(dshHome)
    await capture.settleTurn('s4', 9)
    await capture.settleIdle('s4')
    expect((await readLedger(dshHome, 's4')).turns).toEqual([])
  })
})
