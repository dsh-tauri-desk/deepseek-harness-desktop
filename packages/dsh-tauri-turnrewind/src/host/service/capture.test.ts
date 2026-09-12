import type { WorkspaceQueue } from './queue'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { TURNREWIND_REASON_SNAPSHOT_FAILED } from '../../shared/constants'
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

function captureFor(dshHome: string, captured: number[] = [], queue: WorkspaceQueue = createWorkspaceQueue()) {
  const capture = createTurnCapture({
    dshHome,
    queue,
    onCaptured: (_sessionId, _turn, fileCount) => captured.push(fileCount),
  })
  captures.push(capture)
  return capture
}

/** 可注入失败的队列包装（真实队列放行，`failing` 期间一律拒绝）：复现 git/IO 抛错。 */
function faultyQueue(): { queue: WorkspaceQueue, setFailing: (value: boolean) => void } {
  const real = createWorkspaceQueue()
  let failing = false
  return {
    queue: {
      run: (key, task) => (failing ? Promise.reject(new Error('injected failure')) : real.run(key, task)),
      size: () => real.size(),
    },
    setFailing: (value: boolean) => {
      failing = value
    },
  }
}

/**
 * 可闸门队列：闸门关上后 `run` 一律先挂起，用来把「实时读数那次 git 调用正在飞」
 * 这一刻定住（复现「重置读数」与「在飞刷新」的赛跑）。真实队列照旧执行，串行语义不变；
 * `waitForCompleted` 让用例等到那次放行后的 git 真正跑完，而不是靠固定 sleep 猜时间。
 */
function gatedQueue(): {
  queue: WorkspaceQueue
  close: () => void
  open: () => void
  waitForRun: () => Promise<void>
  waitForCompleted: () => Promise<void>
} {
  const real = createWorkspaceQueue()
  let gate: Promise<void> | null = null
  let openGate: (() => void) | null = null
  let notifyArrived: (() => void) | null = null
  let notifyCompleted: (() => void) | null = null
  let arrived = Promise.resolve()
  let completed = Promise.resolve()
  return {
    queue: {
      async run<T>(key: string, task: () => Promise<T>): Promise<T> {
        if (gate === null)
          return real.run(key, task)
        notifyArrived?.()
        await gate
        const result = await real.run(key, task)
        notifyCompleted?.()
        return result
      },
      size: () => real.size(),
    },
    close: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
      arrived = new Promise<void>((resolve) => {
        notifyArrived = resolve
      })
      completed = new Promise<void>((resolve) => {
        notifyCompleted = resolve
      })
    },
    open: () => {
      const release = openGate
      gate = null
      openGate = null
      release?.()
    },
    waitForRun: () => arrived,
    waitForCompleted: () => completed,
  }
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

  it('before 快照抛异常（而非收敛成结果对象）时也留一笔账，客户端不会永久缺这一轮', async () => {
    const { dshHome, worktree } = await fixture()
    const { queue, setFailing } = faultyQueue()
    const capture = captureFor(dshHome, [], queue)

    // 复现 git/IO 抛错：runBeginTurn 里的 queue.run 直接拒绝，before 快照连结果对象都没有。
    setFailing(true)
    await capture.beginTurn('s7', 1, worktree)
    setFailing(false)
    // 结算没有条目可结算，但不能因此把这一轮从账本里抹掉（客户端靠账本行停止重试）。
    await capture.settleIdle('s7')

    const ledger = await readLedger(dshHome, 's7')
    expect(ledger.turns.map(turn => turn.turn)).toEqual([1])
    expect(ledger.turns[0]?.unavailable).toBe(TURNREWIND_REASON_SNAPSHOT_FAILED)
    expect(ledger.turns[0]?.beforeRef).toBe('')
  })

  it('结算中途抛错时保留条目，下一次 idle 兜底把这一轮补上（而不是永远没有记录）', async () => {
    const { dshHome, worktree } = await fixture()
    const { queue, setFailing } = faultyQueue()
    const capture = captureFor(dshHome, [], queue)

    await capture.beginTurn('s8', 1, worktree)
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')

    // after 快照这一步抛错：账本还没有这一轮。
    setFailing(true)
    await expect(capture.settleTurn('s8', 1)).rejects.toThrow('injected failure')
    expect((await readLedger(dshHome, 's8')).turns).toEqual([])

    // 条目留在活动表里 → 下一次 idle 兜底重试成功（真实运行时任何一次 idle 都会重新扫）。
    setFailing(false)
    await capture.settleIdle('s8')
    const ledger = await readLedger(dshHome, 's8')
    expect(ledger.turns.map(turn => turn.turn)).toEqual([1])
    expect(ledger.turns[0]?.files.map(file => file.path)).toEqual(['a.txt'])
  })
})

describe('运行中提示条的读数生命周期', () => {
  it('新一轮开始时上一轮的读数立刻作废：提示条只反映当前这一轮', async () => {
    const { dshHome, worktree } = await fixture()
    const capture = captureFor(dshHome)

    await capture.beginTurn('s9', 1, worktree)
    expect(capture.liveState('s9')).toMatchObject({ active: true, turn: 1 })

    // 第 1 轮还在后台结算（after 快照排队），用户已经发了新消息：
    // 此时若还报第 1 轮的读数，客户端提示条就会显示跨轮的累加数字。
    await capture.beginTurn('s9', 2, worktree)
    expect(capture.liveState('s9')).toMatchObject({ active: true, turn: 2 })
  })

  it('会话结束重置读数后，该轮的结算与卡片照常（重置只作用于过程态）', async () => {
    const { dshHome, worktree } = await fixture()
    const capture = captureFor(dshHome)

    await capture.beginTurn('s10', 1, worktree)
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    // 会话结束：读数归零，客户端提示条立刻消失。
    capture.resetLive('s10')
    expect(capture.liveState('s10')).toEqual({ active: false, turn: null, fileCount: 0, insertions: 0, deletions: 0 })

    // 条目没有被丢：turn 尾部的变更卡片仍然照常落账。
    await capture.settleTurn('s10', 1)
    const ledger = await readLedger(dshHome, 's10')
    expect(ledger.turns.map(turn => turn.turn)).toEqual([1])
    expect(ledger.turns[0]?.files.map(file => file.path)).toEqual(['a.txt'])
  })

  it('resetLive 按会话与轮次精确作废，不误伤其他会话', async () => {
    const { dshHome, worktree } = await fixture()
    const capture = captureFor(dshHome)

    await capture.beginTurn('s11', 1, worktree)
    await capture.beginTurn('s12', 1, worktree)

    capture.resetLive('s11')
    expect(capture.liveState('s11').active).toBe(false)
    expect(capture.liveState('s12')).toMatchObject({ active: true, turn: 1 })

    // 按轮次也会精确命中：清 s12 的第 1 轮后两个会话都不再上报读数。
    capture.resetLive('s12', 1)
    expect(capture.liveState('s12').active).toBe(false)
  })

  it('重置与在飞的实时刷新赛跑时，晚到的读数不会把提示条复活', async () => {
    const { dshHome, worktree } = await fixture()
    const gate = gatedQueue()
    const capture = captureFor(dshHome, [], gate.queue)

    await capture.beginTurn('s13', 1, worktree)
    expect(capture.liveState('s13')).toMatchObject({ active: true, turn: 1 })

    // 关上闸门后，下一次定时刷新（1.5s）会挂在队列里 —— 等它真的开始。
    gate.close()
    try {
      await gate.waitForRun()
      // 读数还在飞的时候会话结束：重置必须生效，且在飞结果落地之后依然生效。
      capture.resetLive('s13')
    }
    finally {
      gate.open()
    }
    // 等到那次放行的 git 跑完（不加世代闸门时它会在这里把读数写回来）。
    await gate.waitForCompleted()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(capture.liveState('s13').active).toBe(false)
  })

  it('读数归零不等于这一轮已落定：撤销判定仍然看结算状态', async () => {
    const { dshHome, worktree } = await fixture()
    const capture = captureFor(dshHome)

    expect(capture.isTurnPending('s14', 1)).toBe(false)

    await capture.beginTurn('s14', 1, worktree)
    expect(capture.isTurnPending('s14', 1)).toBe(true)
    expect(capture.isTurnPending('s14')).toBe(true)
    expect(capture.isTurnPending('s14', 2)).toBe(false)
    expect(capture.isTurnPending('s15')).toBe(false)

    // 会话结束（读数归零）之后这一轮仍在后台结算：撤销必须继续被拒绝。
    capture.resetLive('s14')
    expect(capture.liveState('s14').active).toBe(false)
    expect(capture.isTurnPending('s14', 1)).toBe(true)

    await capture.settleTurn('s14', 1)
    expect(capture.isTurnPending('s14', 1)).toBe(false)
    expect(capture.isTurnPending('s14')).toBe(false)
  })

  it('工作区里的嵌套仓库不会让运行中读数凭空多出文件（提示条假报 +N）', async () => {
    // 回归背景：`entry.nestedDirs` 此前只用于结算时的 after 快照，没传进 liveDiff ——
    // 实时读数的 `git add --all` 会把嵌套仓库当 gitlink 写进私有 index，而 before
    // 快照里没有它们，读数于是报出「2 个文件已更改 +2 -0」这种工作区根本没发生过的
    // 改动（用户实际反馈）。这里钉的是这条**接线**：本轮的改动只有 a.txt 一行。
    const { dshHome, worktree } = await fixture()
    const nested = join(worktree, 'source', 'react-use')
    await mkdir(nested, { recursive: true })
    await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', nested], { windowsHide: true })
    await writeFile(join(nested, 'inner.txt'), 'v1\n', 'utf8')
    const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=test']
    await run('git', ['-C', nested, ...identity, 'add', '--all'], { windowsHide: true })
    await run('git', ['-C', nested, ...identity, 'commit', '--quiet', '-m', 'init'], { windowsHide: true })
    // 源仓库登记成 gitlink（被跟踪的嵌套仓库，不是被忽略的参考克隆）。
    await run('git', ['-C', worktree, ...identity, 'add', 'source/react-use'], { windowsHide: true })

    const capture = captureFor(dshHome)
    await capture.beginTurn('s16', 1, worktree)
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')

    // 等第一次定时刷新（1.5s 起）落地：读数出现就必须正好是 a.txt 这一处改动。
    const deadline = Date.now() + 15_000
    while (capture.liveState('s16').fileCount === 0 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50))

    expect(capture.liveState('s16')).toMatchObject({ active: true, turn: 1, fileCount: 1, insertions: 1, deletions: 0 })
  })
})
