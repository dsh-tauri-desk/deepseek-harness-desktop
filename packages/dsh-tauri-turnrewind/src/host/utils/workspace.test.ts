import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { isSystemSensitivePath, workspaceHash, workspaceKey } from './workspace'

const temporaryDirectories: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-turnrewind-workspace-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('isSystemSensitivePath', () => {
  it('rejects the home directory, its ancestors, and drive roots', () => {
    expect(isSystemSensitivePath(process.env.USERPROFILE ?? process.env.HOME ?? '')).toBe(true)
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    if (home.length > 0)
      expect(isSystemSensitivePath(join(home, '..'))).toBe(true)
    if (process.platform === 'win32')
      expect(isSystemSensitivePath('C:\\')).toBe(true)
  })

  it('accepts an ordinary project directory', async () => {
    const root = await tempRoot()
    expect(isSystemSensitivePath(root)).toBe(false)
  })
})

describe('workspaceKey', () => {
  it('folds casing on Windows so one directory cannot spawn two snapshot domains', () => {
    const key = workspaceKey('C:\\Repo\\Sub')
    if (process.platform === 'win32')
      expect(key).toBe(workspaceKey('c:\\repo\\sub'))
    expect(workspaceHash('C:\\Repo')).toBe(workspaceHash('C:\\Repo'))
  })
})
