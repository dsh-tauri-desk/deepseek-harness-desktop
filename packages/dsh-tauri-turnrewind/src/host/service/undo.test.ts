import type { SnapshotStore, TurnRecord } from '../types'
import { execFile } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { TURNREWIND_PLUGIN_NAME } from '../../shared/constants'
import { REASON_ALREADY_UNDONE, REASON_CONFLICT, REASON_EXPIRED, REASON_GIT_REQUIRED, REASON_TURN_ACTIVE } from '../config/constants'
import { clearHostRuntime, resetHostRuntime, setCurrentHostInstance } from '../config/runtime'
import { capture } from './capture'
import { ledger } from './ledger'
import { snapshot } from './snapshot'
import { turns } from './turns'
import { undo } from './undo'
import { workspace } from './workspace'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

const run = promisify(execFile)

const temporaryDirectories: string[] = []

/** 绑定的宿主实例：会话 cwd 决定 `undo` 自己解析出的「当前工作区」。 */
let hostCwd = ''

function bindHost(cwd: string): void {
  hostCwd = cwd
  setCurrentHostInstance({
    sessions: {
      get: (id: string) => ({ id, header: { cwd: hostCwd } }),
    },
  })
}

interface Fixture {
  worktree: string
  sessionId: string
  turn: number
  record: TurnRecord
  store: SnapshotStore
}

/**
 * 造一个「一轮改了一个文件」的真实场景：before 快照 → 改文件 → after 快照 →
 * 差异算好写进账本，等价于 capture.ts 在真实 turn 里做的事。
 */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-turnrewind-undo-'))
  temporaryDirectories.push(root)
  const worktree = join(root, 'project')
  await mkdir(worktree, { recursive: true })
  await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', worktree], { windowsHide: true })
  await writeFile(join(worktree, 'a.txt'), 'first\n', 'utf8')

  const sessionId = 'session-undo'
  const turn = 1
  // 账本里的 workspaceRoot 必须是会话当前解析出的同一路径，否则归属校验会拒掉自己。
  bindHost(worktree)
  const probe = await workspace.resolve(sessionId)
  if (!probe.ok)
    throw new Error('fixture probe failed')
  const store = snapshot.resolve(probe.root)
  const before = await snapshot.capture(store, snapshot.ref(sessionId, turn, 'before'), 'before')
  await writeFile(join(worktree, 'a.txt'), 'first\nsecond\n', 'utf8')
  await writeFile(join(worktree, 'added.txt'), 'new\n', 'utf8')
  const after = await snapshot.capture(store, snapshot.ref(sessionId, turn, 'after'), 'after')
  if (!before.ok || !after.ok)
    throw new Error('fixture capture failed')
  const diff = await snapshot.diff(store, before.commit, after.commit)
  if (!diff.ok)
    throw new Error('fixture diff failed')

  let insertions = 0
  let deletions = 0
  for (const change of diff.changes) {
    insertions += change.insertions ?? 0
    deletions += change.deletions ?? 0
  }
  const record: TurnRecord = {
    turn,
    beforeRef: snapshot.ref(sessionId, turn, 'before'),
    afterRef: snapshot.ref(sessionId, turn, 'after'),
    files: diff.changes,
    insertions,
    deletions,
    createdAt: Date.now(),
    undoneAt: null,
    unavailable: null,
  }
  await turns.note(sessionId, { workspaceRoot: store.worktree, isGit: true, unavailableReason: null })
  await turns.record(sessionId, record)
  return { worktree, sessionId, turn, record, store }
}

beforeEach(() => {
  resetTestDshHome()
  // 账本与私有快照仓都在 <DSH_HOME>/<feature> 下，resetTestDshHome 不清这个目录。
  rmSync(join(testDshHome, TURNREWIND_PLUGIN_NAME), { recursive: true, force: true })
  resetHostRuntime()
})

afterEach(async () => {
  capture.dispose()
  clearHostRuntime()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('undo.turn', () => {
  it('restores the workspace and marks the turn undone', async () => {
    const { worktree, sessionId, turn } = await fixture()
    const outcome = await undo.turn(sessionId, turn)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok)
      return
    expect(outcome.failed).toEqual([])
    expect(outcome.restored).toContain('a.txt')
    expect(outcome.removed).toContain('added.txt')
    expect((await readFile(join(worktree, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('first\n')
    expect(existsSync(join(worktree, 'added.txt'))).toBe(false)
  })

  it('refuses with the conflict list and changes nothing when the file changed again', async () => {
    const { worktree, sessionId, turn } = await fixture()
    await writeFile(join(worktree, 'a.txt'), 'user edit after the turn\n', 'utf8')
    const outcome = await undo.turn(sessionId, turn)
    expect(outcome.ok).toBe(false)
    if (outcome.ok)
      return
    expect(outcome.code).toBe(409)
    expect(outcome.error).toBe(REASON_CONFLICT)
    expect(outcome.conflicts?.map(conflict => conflict.path)).toEqual(['a.txt'])
    // 预检发生在动文件之前：内容与新增文件都保持原样。
    expect(await readFile(join(worktree, 'a.txt'), 'utf8')).toBe('user edit after the turn\n')
    expect(existsSync(join(worktree, 'added.txt'))).toBe(true)
  })

  it('rejects a second undo of the same turn', async () => {
    const { sessionId, turn } = await fixture()
    expect((await undo.turn(sessionId, turn)).ok).toBe(true)
    const second = await undo.turn(sessionId, turn)
    expect(second.ok).toBe(false)
    if (!second.ok)
      expect(second.error).toBe(REASON_ALREADY_UNDONE)
  })

  it('returns 404 for a turn with no record', async () => {
    const { sessionId } = await fixture()
    const outcome = await undo.turn(sessionId, 42)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok)
      expect(outcome.code).toBe(404)
  })

  it('refuses when the session now points at another workspace', async () => {
    const { worktree, sessionId, turn } = await fixture()
    // 会话 cwd 切到另一个真实 Git 仓库：探测成功但与账本里的 workspaceRoot 不同。
    const other = join(worktree, 'other')
    await mkdir(other, { recursive: true })
    await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', other], { windowsHide: true })
    bindHost(other)
    const outcome = await undo.turn(sessionId, turn)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok)
      expect(outcome.code).toBe(403)
  })

  it('reports the Git requirement for a non-repository ledger', async () => {
    await turns.note('session-nogit', {
      workspaceRoot: null,
      isGit: false,
      unavailableReason: REASON_GIT_REQUIRED,
    })
    await turns.record('session-nogit', {
      turn: 1,
      beforeRef: '',
      afterRef: '',
      files: [],
      insertions: 0,
      deletions: 0,
      createdAt: Date.now(),
      undoneAt: null,
      unavailable: null,
    })
    const outcome = await undo.turn('session-nogit', 1)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok)
      expect(outcome.error).toBe(REASON_GIT_REQUIRED)
  })

  it('refs 消失时把该轮落为「已过期」终态，而不是每次点击都撞同一个模糊错误', async () => {
    const { sessionId, turn, store } = await fixture()
    await snapshot.remove(store, [snapshot.ref(sessionId, turn, 'before')])
    const outcome = await undo.turn(sessionId, turn)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe(409)
      expect(outcome.error).toBe(REASON_EXPIRED)
    }
    // 终态写回账本：卡片能给出确定结论，后续点击不会重复走一遍 git 校验。
    const current = await ledger.load(sessionId)
    const record = current.turns.find(item => item.turn === turn)
    expect(record?.unavailable).toBe(REASON_EXPIRED)
    expect(record?.beforeRef).toBe('')
  })

  it('代际不一致时直接落「已过期」——即使 refs 还在，也不能信任它是同一批快照', async () => {
    const { worktree, sessionId, turn, record, store } = await fixture()
    const generation = await snapshot.generation(worktree)
    expect(generation).toBeTypeOf('string')
    // 真实捕获路径会把代数写进账本记录；fixture 手工补上。
    await turns.record(sessionId, { ...record, generation })

    // 模拟「标记文件被清理掉、但私有仓还在」：下一次捕获会重新分配一个代数，
    // 而旧 refs 依然存在——此时**只有代数比对**能发现这轮记录不可信。
    await rm(`${store.gitDir}.json`, { force: true })
    const recapture = await snapshot.capture(store, snapshot.ref(sessionId, turn + 100, 'before'), 'recheck')
    expect(recapture.ok).toBe(true)
    expect(await snapshot.generation(worktree)).not.toBe(generation)

    const outcome = await undo.turn(sessionId, turn)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe(409)
      expect(outcome.error).toBe(REASON_EXPIRED)
    }
    // 关键：refs 仍在（说明不是「ref 消失」那条兜底在生效），且工作区一个字节都没动。
    expect(await snapshot.read(store, record.beforeRef)).not.toBeNull()
    expect(await readFile(join(worktree, 'a.txt'), 'utf8')).toBe('first\nsecond\n')
    expect(existsSync(join(worktree, 'added.txt'))).toBe(true)
  })

  it('会话仍在跑（有在飞 turn）时拒绝撤销', async () => {
    const { worktree, sessionId, turn } = await fixture()
    // 本轮登记在飞：撤销判定必须看结算状态，而不是读数是否归零。
    await capture.begin(sessionId, turn)
    const outcome = await undo.turn(sessionId, turn)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe(409)
      expect(outcome.error).toBe(REASON_TURN_ACTIVE)
    }
    // 拒绝发生在动文件之前。
    expect(await readFile(join(worktree, 'a.txt'), 'utf8')).toBe('first\nsecond\n')
  })
})
