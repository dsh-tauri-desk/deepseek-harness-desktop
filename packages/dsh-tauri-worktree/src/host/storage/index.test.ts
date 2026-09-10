/**
 * host/storage/index.test.ts — 按会话分文件的 binding ledger 契约：
 * 独立读写互不干扰、单会话删除、旧整表一键迁移幂等。
 */

import type { Binding } from '../types'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import {
  assertSafeSessionId,
  listBindings,
  listBindingsSync,
  loadBinding,
  loadBindingSync,
  migrateLegacyLedger,
  removeBinding,
  saveBinding,
} from '.'

function tempRoot(): string {
  return join(tmpdir(), `dsh-worktree-storage-${randomUUID()}`)
}

function makeBinding(sessionId: string, hash = 'hash-a'): Binding {
  return {
    sessionId,
    sourceSessionId: 'source-a',
    hash,
    dirname: 'repo',
    worktreePath: join(tmpdir(), `wt-${sessionId}`),
    projectPath: '/tmp/repo',
    branchName: 'dsh/x',
    ownsBranch: true,
    createdAt: new Date().toISOString(),
    log: [],
  }
}

describe('按会话分文件的 binding ledger', () => {
  it('saveBinding/loadBinding/loadBindingSync 往返一致', async () => {
    const root = tempRoot()
    const binding = makeBinding('session-1')
    await saveBinding(root, 'session-1', binding)
    await expect(loadBinding(root, 'session-1')).resolves.toEqual(binding)
    expect(loadBindingSync(root, 'session-1')).toEqual(binding)
  })

  it('同组不同会话各自读写互不干扰；覆盖只作用于自己的文件', async () => {
    const root = tempRoot()
    const a = makeBinding('session-a', 'hash-a')
    const b = makeBinding('session-b', 'hash-b')
    await saveBinding(root, 'session-a', a)
    await saveBinding(root, 'session-b', b)
    await saveBinding(root, 'session-a', { ...a, branchName: 'dsh/updated' })

    await expect(loadBinding(root, 'session-a')).resolves.toMatchObject({ branchName: 'dsh/updated' })
    await expect(loadBinding(root, 'session-b')).resolves.toEqual(b)
    // 未写入的会话读不到（不因别人写入而串扰）。
    await expect(loadBinding(root, 'session-none')).resolves.toBeNull()
  })

  it('removeBinding 只删指定会话，其余保留', async () => {
    const root = tempRoot()
    await saveBinding(root, 'session-a', makeBinding('session-a'))
    await saveBinding(root, 'session-b', makeBinding('session-b'))
    await removeBinding(root, 'session-a')

    await expect(loadBinding(root, 'session-a')).resolves.toBeNull()
    await expect(loadBinding(root, 'session-b')).resolves.toMatchObject({ sessionId: 'session-b' })
    // 再次删除不存在项视为成功。
    await expect(removeBinding(root, 'session-a')).resolves.toBeUndefined()
  })

  it('listBindings / listBindingsSync 枚举当前全部绑定', async () => {
    const root = tempRoot()
    await saveBinding(root, 'session-x', makeBinding('session-x', 'hash-x'))
    await saveBinding(root, 'session-y', makeBinding('session-y', 'hash-y'))

    const synced = listBindingsSync(root)
    expect(synced.map(b => b.sessionId).sort()).toEqual(['session-x', 'session-y'])
    const asyncAll = await listBindings(root)
    expect(asyncAll.map(b => b.sessionId).sort()).toEqual(['session-x', 'session-y'])
  })

  it('旧整表 ledger.json 一次性迁移到按会话文件并删除旧文件（幂等）', async () => {
    const root = tempRoot()
    mkdirSync(root, { recursive: true })
    const legacy = {
      'session-1': makeBinding('session-1', 'hash-1'),
      'session-2': makeBinding('session-2', 'hash-2'),
    }
    writeFileSync(join(root, 'ledger.json'), JSON.stringify(legacy, null, 2))

    await migrateLegacyLedger(root)
    // 已拆散并按会话可读。
    await expect(loadBinding(root, 'session-1')).resolves.toMatchObject({ sessionId: 'session-1' })
    await expect(loadBinding(root, 'session-2')).resolves.toMatchObject({ sessionId: 'session-2' })
    // 旧整表已删除；每个会话独立 .json 存在于 ledger/ 下。
    expect(existsSync(join(root, 'ledger.json'))).toBe(false)
    const files = readdirSync(join(root, 'ledger')).sort()
    expect(files).toEqual(['session-1.json', 'session-2.json'])
    // 幂等：再次迁移不抛错且文件不变。
    writeFileSync(join(root, 'ledger.json'), JSON.stringify(legacy))
    await expect(migrateLegacyLedger(root)).resolves.toBeUndefined()
    await expect(loadBinding(root, 'session-1')).resolves.toMatchObject({ sessionId: 'session-1' })
  })

  it('无旧整表且无 ledger/ 目录时迁移与读取均安全', async () => {
    const root = tempRoot()
    await expect(migrateLegacyLedger(root)).resolves.toBeUndefined()
    await expect(loadBinding(root, 'any')).resolves.toBeNull()
    expect(listBindingsSync(root)).toEqual([])
    expect(existsSync(join(root, 'ledger.json'))).toBe(false)
  })
})

describe('assertSafeSessionId（路径穿越防护）', () => {
  it('放行合法会话 id（字母数字、连字符、下划线、点）', () => {
    for (const ok of ['session-1', 'session_a.2', 'a.b-c_d', 'session'])
      expect(assertSafeSessionId(ok)).toBe(ok)
  })

  it('拒绝目录分隔符与遍历序列', () => {
    const bad = [
      '../evil',
      '..',
      '.',
      '',
      'a/b',
      '..\\..',
      'a\\b',
      '/etc/passwd',
      'C:/x',
      'a:b',
      'a b',
    ]
    for (const id of bad)
      expect(() => assertSafeSessionId(id), `should reject ${JSON.stringify(id)}`).toThrow()
  })

  it('saveBinding/loadBinding/removeBinding 遇非法 id 不落盘读外（只读路径静默返回 null）', async () => {
    const root = tempRoot()
    const binding = makeBinding('session-1')
    for (const id of ['../..', 'a/b', '..']) {
      await expect(saveBinding(root, id, binding)).rejects.toThrow()
      await expect(removeBinding(root, id)).rejects.toThrow()
      // 只读路径按“绝不抛错”契约返回 null，且不得读取外部文件。
      await expect(loadBinding(root, id)).resolves.toBeNull()
      await expect(loadBindingSync(root, id)).toBeNull()
    }
    // 根目录下不得产生穿越残留文件。
    const ledgerDir = join(root, 'ledger')
    if (existsSync(ledgerDir)) {
      const names = readdirSync(ledgerDir)
      for (const name of names)
        expect(name.includes('..')).toBe(false)
    }
  })

  it('迁移前旧整表 ledger.json 存在时，非法 id 也不得经 legacy 回退被读取', async () => {
    // CodeRabbit PR-448 建议：legacy 回退路径同样不做未经校验的键查找——
    // 即使旧整表里有形似穿越的 key，非法 id 仍应整体返回 null。
    const root = tempRoot()
    mkdirSync(root, { recursive: true })
    const legacy = { '../evil': makeBinding('session-1'), 'session-ok': makeBinding('session-1') }
    writeFileSync(join(root, 'ledger.json'), JSON.stringify(legacy))
    for (const id of ['../evil', '..', 'a/b'])
      await expect(loadBindingSync(root, id)).toBeNull()
    // 合法 id 走 migrate（旧表里的非法键会让迁移整体保留旧文件）→ legacy 回退
    // 应读到合法键，而非被非法键污染返回 null。
    const read = await loadBinding(root, 'session-ok')
    expect(read).not.toBeNull()
    expect(read?.sessionId).toBe('session-1')
    expect(read?.branchName).toBe('dsh/x')
  })
})
