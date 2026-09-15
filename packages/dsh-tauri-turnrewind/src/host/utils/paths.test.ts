import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { REASON_NON_EMPTY_DIR, REASON_UNSAFE_PATH } from '../config/constants'
import { assertSafeParents, removeCreatedPath, resolveInsideWorkspace } from './paths'

const temporaryDirectories: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-turnrewind-paths-'))
  temporaryDirectories.push(root)
  return root
}

/** 建一个指向工作区外部的目录链接（Windows 用 junction，无需开发者模式）。 */
function linkOutside(linkPath: string, target: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  }
  catch {
    // 无权限建链接（Windows 未开开发者模式等）：相关断言跳过，不假装通过。
    return false
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('resolveInsideWorkspace', () => {
  it('接受嵌套路径，拒绝逃逸与绝对路径', async () => {
    const root = await tempRoot()
    expect(resolveInsideWorkspace(root, 'src/a.ts')).not.toBeNull()
    expect(resolveInsideWorkspace(root, '../outside.txt')).toBeNull()
    expect(resolveInsideWorkspace(root, 'a/../../outside.txt')).toBeNull()
    expect(resolveInsideWorkspace(root, 'C:\\Other\\file.txt')).toBeNull()
    expect(resolveInsideWorkspace(root, '')).toBeNull()
  })
})

describe('assertSafeParents（撤销写盘前的最后一道防线）', () => {
  it('普通父目录通过；父级是文件则拒绝', async () => {
    const root = await tempRoot()
    mkdirSync(join(root, 'sub'), { recursive: true })
    expect(assertSafeParents(root, join(root, 'sub', 'a.txt')).ok).toBe(true)
    writeFileSync(join(root, 'plain.txt'), 'x')
    expect(assertSafeParents(root, join(root, 'plain.txt', 'a.txt')).ok).toBe(false)
  })

  it('父级是指向工作区外部的链接时拒绝（词法检查看不到这一层）', async () => {
    const root = await tempRoot()
    const outside = join(root, '..', `outside-${Date.now()}`)
    mkdirSync(outside, { recursive: true })
    temporaryDirectories.push(outside)
    const link = join(root, 'linked')
    if (!linkOutside(link, outside))
      return
    // 词法上 `linked/evil.txt` 在工作区内——正因如此才必须按文件系统事实再判一次。
    const lexical = resolveInsideWorkspace(root, 'linked/evil.txt')
    expect(lexical).not.toBeNull()
    const safe = assertSafeParents(root, lexical as string)
    expect(safe).toEqual({ ok: false, reason: REASON_UNSAFE_PATH })
  })

  it('父级尚未存在时通过（新增文件的正常路径由恢复过程创建）', async () => {
    const root = await tempRoot()
    expect(assertSafeParents(root, join(root, 'not', 'yet', 'a.txt')).ok).toBe(true)
  })
})

describe('removeCreatedPath', () => {
  it('删除文件与空目录，拒绝非空目录', async () => {
    const root = await tempRoot()
    writeFileSync(join(root, 'a.txt'), 'x')
    expect(removeCreatedPath(join(root, 'a.txt'))).toEqual({ ok: true })
    expect(existsSync(join(root, 'a.txt'))).toBe(false)

    mkdirSync(join(root, 'empty'))
    expect(removeCreatedPath(join(root, 'empty'))).toEqual({ ok: true })

    mkdirSync(join(root, 'full'))
    writeFileSync(join(root, 'full', 'keep.txt'), 'important')
    // 递归删除可能毁掉本 turn 从未碰过、也不在快照里的文件：只拒绝，绝不递归删。
    expect(removeCreatedPath(join(root, 'full'))).toEqual({ ok: false, reason: REASON_NON_EMPTY_DIR })
    expect(existsSync(join(root, 'full', 'keep.txt'))).toBe(true)
  })

  it('路径已消失按成功结算', async () => {
    const root = await tempRoot()
    expect(removeCreatedPath(join(root, 'gone.txt'))).toEqual({ ok: true })
  })
})
