import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { gitInRepo } from './git'

const run = promisify(execFile)

const temporaryDirectories: string[] = []

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-turnrewind-git-'))
  temporaryDirectories.push(root)
  await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', root], { windowsHide: true })
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('gitInRepo', () => {
  it('把 git 失败收敛成结果对象，而不是抛异常', async () => {
    const root = await tempRepo()
    expect((await gitInRepo(root, ['rev-parse', '--show-toplevel'])).ok).toBe(true)
    const failure = await gitInRepo(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/does-not-exist'])
    expect(failure.ok).toBe(false)
  })

  it('短命命令也不会冒出未处理的 stdin 错误（Linux CI 上曾表现为 EPIPE）', async () => {
    // 回归背景：execFile 默认给 stdin 开管道，而 git 命令往往在写入前就退出；
    // 空写那次失败在 Linux 上是未处理的 'error' 事件，会以 uncaughtException 冒泡
    // （CI 里报 "Error: write EPIPE"），Windows 因管道语义不同不触发。
    const root = await tempRepo()
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onUncaught)
    try {
      // 连续多次极短命令：把「子进程先退出、stdin 后写」的竞态窗口放到最大。
      for (let index = 0; index < 12; index += 1)
        expect((await gitInRepo(root, ['rev-parse', '--show-toplevel'])).ok).toBe(true)
      // 排空事件循环，让潜在的异步 stdin 错误有机会浮出来。
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    finally {
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onUncaught)
    }
    expect(uncaught).toEqual([])
  })
})
