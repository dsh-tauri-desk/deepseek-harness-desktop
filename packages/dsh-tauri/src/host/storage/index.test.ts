/**
 * host/storage/index.test.ts — 原子写契约：EPERM 锁竞争重试 + 内容落盘 + 临时清理。
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAtomicFsStorage, writeAtomic } from './index'

/** 每个用例独立的临时目录，避免跨用例污染。 */
function tempDir(): string {
  return join(tmpdir(), `dsh-storage-test-${randomUUID()}`)
}

describe('writeAtomic', () => {
  it('写入目标文件并保持内容完整', async () => {
    const dir = tempDir()
    const target = join(dir, 'ledger.json')
    const value = '{ "a": 1 }\n'

    await expect(writeAtomic(target, value)).resolves.toBeUndefined()
    await expect(
      (await import('node:fs/promises')).readFile(target, 'utf8'),
    ).resolves.toBe(value)
  })

  it('在同目录已存在同名临时文件时也不互相覆盖（每次用独立临时名）', async () => {
    const dir = tempDir()
    const target = join(dir, 'ledger.json')
    await writeAtomic(target, 'first')
    await writeAtomic(target, 'second')
    await expect(
      (await import('node:fs/promises')).readFile(target, 'utf8'),
    ).resolves.toBe('second')
  })
})

describe('createAtomicFsStorage setItem/getItem', () => {
  it('对象序列化往返一致', async () => {
    const store = createAtomicFsStorage(tempDir())
    await store.setItem('ledger.json', '{ "ok": true }\n')
    // unstorage fs getItem 会自动 JSON.parse，故按解析后的对象断言。
    await expect(store.getItem('ledger.json')).resolves.toEqual({ ok: true })
  })

  it('冒号子目录 key 落到独立文件且互不干扰（按会话分文件的基础）', async () => {
    const dir = tempDir()
    const store = createAtomicFsStorage(dir)
    await store.setItem('ledger:session-a.json', '{ "a": 1 }\n')
    await store.setItem('ledger:session-b.json', '{ "b": 2 }\n')
    await store.setItem('ledger:session-a.json', '{ "a": 3 }\n')

    // 各自独立可读，且覆盖只作用于自己的文件。
    await expect(store.getItem('ledger:session-a.json')).resolves.toEqual({ a: 3 })
    await expect(store.getItem('ledger:session-b.json')).resolves.toEqual({ b: 2 })

    // 枚举只暴露本方案的 `<sessionId>.json` 叶子键。
    const keys = await store.getKeys()
    expect([...keys].sort()).toEqual(['ledger:session-a.json', 'ledger:session-b.json'])

    // removeItem 只删指定会话文件。
    await store.removeItem('ledger:session-a.json')
    await expect(store.hasItem('ledger:session-a.json')).resolves.toBe(false)
    await expect(store.hasItem('ledger:session-b.json')).resolves.toBe(true)
  })
})

describe('原子写 EPERM 锁竞争重试', () => {
  const retries = 2

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rename 前几次抛 EPERM 时退避重试，最终成功落盘', async () => {
    const dir = tempDir()
    const target = join(dir, 'ledger.json')

    // 包内直接 import 的 rename 无法被 vi.mock 轻易替换，改用模块级 mock 拦截。
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:fs/promises')>()
      let attempts = 0
      return {
        ...original,
        rename: vi.fn(async (...args: Parameters<typeof original.rename>) => {
          if (attempts++ < retries) {
            const err = new Error('operation not permitted') as NodeJS.ErrnoException
            err.code = 'EPERM'
            throw err
          }
          return original.rename(...args)
        }),
      }
    })
    // 从被 mock 的模块重新导入被测对象，确保其内部引用同一 rename。
    vi.resetModules()
    const { writeAtomic: writeAtomicRetry } = await import('./index')

    await expect(writeAtomicRetry(target, 'finally-ok')).resolves.toBeUndefined()
    await expect(
      (await import('node:fs/promises')).readFile(target, 'utf8'),
    ).resolves.toBe('finally-ok')
  })

  it('超过重试上限后抛出并清理临时文件', async () => {
    const dir = tempDir()
    const target = join(dir, 'ledger.json')

    vi.doMock('node:fs/promises', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...original,
        rename: vi.fn(async () => {
          const err = new Error('operation not permitted') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        }),
      }
    })
    vi.resetModules()
    const { writeAtomic: writeAtomicFail } = await import('./index')

    await expect(writeAtomicFail(target, 'nope')).rejects.toMatchObject({ code: 'EPERM' })
    const { readdir } = await import('node:fs/promises')
    const leftovers = await readdir(dir).catch(() => [])
    expect(leftovers).toEqual([])
  })
})
