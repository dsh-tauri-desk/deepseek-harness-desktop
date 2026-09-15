import type { SessionLedger } from '../types'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'pathe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { LEDGER_SUBDIR, LEDGER_VERSION, SNAPSHOT_FEATURE_DIR } from '../config/constants'
import { ledger } from './ledger'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

function blank(sessionId: string): SessionLedger {
  return {
    version: LEDGER_VERSION,
    sessionId,
    workspaceRoot: null,
    isGit: false,
    unavailableReason: null,
    turns: [],
  }
}

/** 账本键由 ledger 服务内部拼装（文件名安全化 + 短哈希防撞），落点与 storage 的 base 一致。 */
function ledgerPath(sessionId: string): string {
  const sanitized = sessionId.replace(/[^\w.-]/g, '_').slice(0, 96) || 'session'
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
  return join(testDshHome, SNAPSHOT_FEATURE_DIR, LEDGER_SUBDIR, `${sanitized}-${digest}.json`)
}

/** `resetTestDshHome` 不覆盖插件数据目录（账本），用例间必须自行清理。 */
function cleanPluginData(): void {
  rmSync(join(testDshHome, SNAPSHOT_FEATURE_DIR), { recursive: true, force: true })
}

beforeEach(() => {
  vi.restoreAllMocks()
  resetTestDshHome()
  cleanPluginData()
})

describe('ledger', () => {
  it('round-trips a session ledger through the atomic writer', async () => {
    const value = blank('session-1')
    value.workspaceRoot = 'C:/proj'
    value.isGit = true
    await ledger.save(value)
    const restored = await ledger.load('session-1')
    expect(restored).toMatchObject({ sessionId: 'session-1', workspaceRoot: 'C:/proj', isGit: true })
    expect(restored.turns).toEqual([])
    // 文件确实是 JSON 文本（原子写落盘），并且按会话分文件落在 DSH_HOME 下。
    const raw = await readFile(ledgerPath('session-1'), 'utf8')
    expect(JSON.parse(raw).sessionId).toBe('session-1')
    expect(ledgerPath('session-1').startsWith(testDshHome.replaceAll('\\', '/'))).toBe(true)
  })

  it('falls back to an empty ledger on malformed or version-mismatched files', async () => {
    const path = ledgerPath('session-bad')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{ not json', 'utf8')
    expect((await ledger.load('session-bad')).turns).toEqual([])

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(path, JSON.stringify({ ...blank('session-bad'), version: LEDGER_VERSION + 1 }), 'utf8')
    const downgraded = await ledger.load('session-bad')
    expect(downgraded.version).toBe(LEDGER_VERSION)
    expect(downgraded.turns).toEqual([])
  })
})
