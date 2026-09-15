import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'pathe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { sessionFiles } from './session-files'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

beforeEach(() => {
  resetTestDshHome()
})

function makeSessionDir(group: string | undefined, marker: string): string {
  const dir = group ? join(testDshHome, 'sessions', group, marker) : join(testDshHome, 'sessions', marker)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('sessionFiles.load', () => {
  it('finds a depth-2 session data directory (sessions/<group>/session-<id>)', () => {
    const dir = makeSessionDir('--project-a--', 'session-abc')
    expect(sessionFiles.load('abc')).toBe(dir)
  })

  it('finds a depth-1 session data directory (sessions/session-<id>)', () => {
    const dir = makeSessionDir(undefined, 'session-xyz')
    expect(sessionFiles.load('xyz')).toBe(dir)
  })

  it('returns null when no session data directory exists', () => {
    expect(sessionFiles.load('missing')).toBeNull()
  })
})

describe('sessionFiles.remove', () => {
  it('removes the located depth-2 directory', () => {
    makeSessionDir('--project-a--', 'session-abc')
    expect(sessionFiles.remove('abc')).toBe(true)
    expect(sessionFiles.load('abc')).toBeNull()
  })

  it('prunes an empty parent group directory after removal', () => {
    makeSessionDir('--project-a--', 'session-abc')
    expect(sessionFiles.remove('abc')).toBe(true)
    expect(sessionFiles.load('abc')).toBeNull()
    expect(existsSync(join(testDshHome, 'sessions', '--project-a--'))).toBe(false)
  })

  it('keeps a parent group directory that still holds other sessions', () => {
    makeSessionDir('--project-a--', 'session-abc')
    makeSessionDir('--project-a--', 'session-def')
    expect(sessionFiles.remove('abc')).toBe(true)
    expect(existsSync(join(testDshHome, 'sessions', '--project-a--'))).toBe(true)
    expect(sessionFiles.load('def')).toBe(join(testDshHome, 'sessions', '--project-a--', 'session-def'))
  })

  it('keeps the sessions root itself when a depth-1 directory is removed', () => {
    const dir = makeSessionDir(undefined, 'session-xyz')
    expect(sessionFiles.remove('xyz')).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(testDshHome, 'sessions'))).toBe(true)
  })

  it('reports false when the session has no data directory', () => {
    expect(sessionFiles.remove('ghost')).toBe(false)
  })
})
