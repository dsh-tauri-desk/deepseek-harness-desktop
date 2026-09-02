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
  listBindings,
  listBindingsSync,
  loadBinding,
  loadBindingSync,
  migrateLegacyLedger,
  removeBinding,
  saveBinding,
} from './index'

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
