import { describe, expect, it } from 'vitest'
import {
  buildCommandInvocation,
  isDirectEntry,
  isSafeGitRef,
  isSafeRelativePath,
  parseGithubSpec,
  parseNpmSpec,
  validateManifest,
} from '../scripts/prebuild'

describe('internal plugin prebuild validation', () => {
  it('accepts pinned Git refs and rejects unsafe ref forms', () => {
    expect(isSafeGitRef('v1.2.3')).toBe(true)
    expect(isSafeGitRef('release/windows-fix')).toBe(true)
    expect(isSafeGitRef('../main')).toBe(false)
    expect(isSafeGitRef('feature//branch')).toBe(false)
    expect(isSafeGitRef('feature@{1}')).toBe(false)
    expect(parseGithubSpec('github:owner/repo#release/windows-fix')).toEqual({
      repo: 'owner/repo',
      ref: 'release/windows-fix',
    })
  })

  it('accepts only exact npm package versions', () => {
    expect(parseNpmSpec('dsh-tauri@0.4.8')).toEqual({ name: 'dsh-tauri', version: '0.4.8' })
    expect(parseNpmSpec('@scope/plugin@1.2.3-beta.1')).toEqual({
      name: '@scope/plugin',
      version: '1.2.3-beta.1',
    })
    expect(parseNpmSpec('dsh-tauri@^0.4.8')).toBeUndefined()
    expect(parseNpmSpec('dsh-tauri@latest')).toBeUndefined()
  })

  it('rejects path aliases and directory traversal', () => {
    expect(isSafeRelativePath('dist/index.js')).toBe(true)
    expect(isSafeRelativePath('README.md')).toBe(true)
    expect(isSafeRelativePath('/tmp/escape')).toBe(false)
    expect(isSafeRelativePath('../escape')).toBe(false)
    expect(isSafeRelativePath('dist/../escape')).toBe(false)
    expect(isSafeRelativePath('dist\\escape')).toBe(false)
    expect(isSafeRelativePath('C:/escape')).toBe(false)
  })

  it('invokes Windows package-manager wrappers through COMSPEC', () => {
    expect(buildCommandInvocation(
      'pnpm',
      ['add', 'C:\\work dir\\plugin.tgz', '--registry', 'https://registry.npmjs.org/'],
      'win32',
      'C:\\Windows\\System32\\cmd.exe',
    )).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/v:off',
        '/s',
        '/c',
        '"pnpm.cmd" "add" "C:\\work dir\\plugin.tgz" "--registry" "https://registry.npmjs.org/"',
      ],
    })
    expect(buildCommandInvocation('git', ['status'], 'win32', 'C:\\Windows\\System32\\cmd.exe')).toEqual({
      executable: 'git',
      args: ['status'],
    })
    expect(() => buildCommandInvocation('pnpm', ['--config', 'value%PATH%'], 'win32', 'cmd.exe'))
      .toThrow(/unsafe command argument/)
  })

  it('matches entry points after canonicalizing filesystem paths', () => {
    expect(isDirectEntry('scripts/../scripts/prebuild.ts', 'scripts/prebuild.ts')).toBe(true)
    expect(isDirectEntry(undefined, 'scripts/prebuild.ts')).toBe(false)
    expect(isDirectEntry('scripts/prebuild.ts', 'scripts/other.ts')).toBe(false)
  })

  it('validates the checked-in internal plugin manifest', () => {
    const manifest = validateManifest()
    expect(manifest.length).toBeGreaterThan(0)
    for (const plugin of manifest) {
      if (plugin.spec.startsWith('github:')) {
        expect(plugin.commit).toMatch(/^[0-9a-f]{40}$/)
      }
      else {
        expect(plugin.integrity).toMatch(/^sha512-/)
      }
    }
  })
})
