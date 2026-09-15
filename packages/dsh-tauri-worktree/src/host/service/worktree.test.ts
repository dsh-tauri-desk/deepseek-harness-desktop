import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { clearHostRuntime, setCurrentHostInstance } from '../config/runtime'
import { projectDirname } from '../utils/git'
import { computeHash, worktreePath } from '../utils/paths'
import { cleaner } from './cleaner'
import { worktree } from './worktree'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

const repositories: string[] = []

beforeEach(() => {
  resetTestDshHome()
  clearHostRuntime()
})

afterEach(() => {
  clearHostRuntime()
  for (const repository of repositories.splice(0))
    rmSync(repository, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createRepository(commit = true): string {
  const repository = mkdtempSync(join(tmpdir(), 'dsh-worktree-repo-'))
  repositories.push(repository)
  git(repository, 'init', '-b', 'main')
  git(repository, 'config', 'user.email', 'test@example.com')
  git(repository, 'config', 'user.name', 'Test')
  writeFileSync(join(repository, 'README.md'), '# repo\n')
  if (commit) {
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'init')
  }
  return repository
}

function expectedPath(repository: string, sessionId: string): string {
  return worktreePath(computeHash(repository, sessionId), projectDirname(repository))
}

function hostWithProcessController(controller: unknown): unknown {
  return new Proxy(
    { get: (name: string) => (name === 'worktreeProcessController' ? controller : undefined) },
    {
      get(target, property, receiver) {
        if (property in target)
          return Reflect.get(target, property, receiver)
        throw new Error(`cannot get property "${String(property)}" without inject`)
      },
    },
  )
}

async function waitForDiscard(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = cleaner.lookup('', jobId)
    if (job && job.state !== 'deleting') {
      if (job.state === 'failed')
        throw new Error(job.error ?? 'discard job failed')
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`discard job ${jobId} did not settle`)
}

describe('worktree.create', () => {
  it('默认从 refs/heads/main 创建 detached 工作树并落盘绑定', async () => {
    const repository = createRepository()
    const sessionId = 'detached-session'

    const result = await worktree.create(repository, sessionId)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    const path = expectedPath(repository, sessionId)
    expect(result.binding.worktreePath).toBe(path)
    expect(result.binding.projectPath).toBe(repository)
    expect(result.binding.ownsBranch).toBe(false)
    expect(result.binding.branchName).toBe('(detached)')
    expect(result.existed).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(repository, 'rev-parse', 'refs/heads/main'))
    expect(git(repository, 'branch', '--list', 'dsh/*')).toBe('')
  })

  it('指定分支时创建 dsh/<branch> 工作树，重名时报错', async () => {
    const repository = createRepository()
    const sessionId = 'branch-session'

    const result = await worktree.create(repository, sessionId, { branchName: 'topic-main-source' })
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    expect(result.binding.branchName).toBe('dsh/topic-main-source')
    expect(result.binding.ownsBranch).toBe(true)
    expect(git(repository, 'branch', '--list', 'dsh/topic-main-source')).toContain('dsh/topic-main-source')

    const conflict = await worktree.create(repository, 'branch-session-2', { branchName: 'dsh/topic-main-source' })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok)
      expect(conflict.error).toBe('分支已存在：dsh/topic-main-source')
  })

  it('目标路径存在未注册的孤儿目录时先清理再重建', async () => {
    const repository = createRepository()
    const sessionId = 'orphan-session'
    const path = expectedPath(repository, sessionId)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'orphan.txt'), 'stale\n')

    const result = await worktree.create(repository, sessionId)
    expect(result.ok).toBe(true)
    expect(existsSync(join(path, 'orphan.txt'))).toBe(false)
    expect(existsSync(join(path, 'README.md'))).toBe(true)
  })

  it('本地缺少 refs/heads/main 时拒绝创建', async () => {
    const repository = createRepository(false)

    const result = await worktree.create(repository, 'no-main-session')
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toContain('本地分支 main 不存在或无法解析（refs/heads/main）')
  })

  it('已绑定且工作树仍注册时幂等返回 existed', async () => {
    const repository = createRepository()
    const sessionId = 'idempotent-session'
    const first = await worktree.create(repository, sessionId)
    expect(first.ok).toBe(true)

    const second = await worktree.create(repository, sessionId)
    expect(second.ok).toBe(true)
    if (!second.ok)
      return
    expect(second.existed).toBe(true)
    expect(second.binding.worktreePath).toBe(expectedPath(repository, sessionId))
  })
})

describe('worktree.remove', () => {
  it('删除前停止该会话的工作树进程', async () => {
    const repository = createRepository()
    const sessionId = 'controller-session'
    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    const stopSessionProcesses = vi.fn(async () => {})
    setCurrentHostInstance(hostWithProcessController({ stopSessionProcesses }) as never)

    const removed = await worktree.remove(sessionId)
    expect(removed.ok).toBe(true)
    expect(stopSessionProcesses).toHaveBeenCalledWith(sessionId, created.binding.worktreePath)
    expect(existsSync(created.binding.worktreePath)).toBe(false)
  })

  it('无宿主实例或控制器缺失时删除依然安全', async () => {
    const repository = createRepository()
    const sessionId = 'no-controller-session'
    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    const removed = await worktree.remove(sessionId)
    expect(removed.ok).toBe(true)
    expect(existsSync(created.binding.worktreePath)).toBe(false)
  })

  it('detach 在无宿主实例时不抛出', async () => {
    const repository = createRepository()
    await worktree.create(repository, 'detach-session')

    await expect(worktree.detach({})).resolves.toEqual([])
  })
})

describe('worktree.discard', () => {
  it('异步删除完成后清空空的 hash 容器', async () => {
    const repository = createRepository()
    const sessionId = 'discard-session'
    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    const discarded = await worktree.discard(sessionId, `${created.binding.hash}/${created.binding.dirname}`)
    expect(discarded.ok).toBe(true)
    if (!discarded.ok || !discarded.jobId)
      throw new Error('discard did not start a job')

    await waitForDiscard(discarded.jobId)

    expect(existsSync(created.binding.worktreePath)).toBe(false)
    expect(existsSync(join(testDshHome, 'worktrees', created.binding.hash))).toBe(false)
    expect(existsSync(join(testDshHome, '.trash', created.binding.hash))).toBe(false)
  })

  it('无绑定且路径已消失时幂等成功且不产生任务', async () => {
    const repository = createRepository()
    const sessionId = 'no-binding-session'
    const key = `${computeHash(repository, sessionId)}/${projectDirname(repository)}`

    const discarded = await worktree.discard(sessionId, key)
    expect(discarded).toEqual({ ok: true })
  })
})

describe('依赖链接', () => {
  it('默认链接 node_modules，并在删除前解链', async () => {
    const repository = createRepository()
    mkdirSync(join(repository, 'node_modules'), { recursive: true })
    writeFileSync(join(repository, 'node_modules', 'index.js'), 'module.exports = 1\n')
    const sessionId = 'linked-session'

    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    const link = join(created.binding.worktreePath, 'node_modules')
    expect(existsSync(link)).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(created.binding.linkedDependencies).toEqual(['node_modules'])

    const removed = await worktree.remove(sessionId)
    expect(removed.ok).toBe(true)
    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(repository, 'node_modules', 'index.js'))).toBe(true)
  })

  it('linkDependencies 为 false 时跳过链接', async () => {
    const repository = createRepository()
    mkdirSync(join(repository, 'node_modules'), { recursive: true })
    const sessionId = 'unlinked-session'

    const created = await worktree.create(repository, sessionId, { linkDependencies: false })
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    expect(existsSync(join(created.binding.worktreePath, 'node_modules'))).toBe(false)
    expect(created.binding.linkedDependencies).toBeUndefined()
  })
})
