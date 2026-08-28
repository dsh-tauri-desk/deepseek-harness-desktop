import { describe, expect, it } from 'vitest'
import { isSafeGitRef, isSafeRelativePath, parseGithubSpec, parseNpmSpec, validateManifest } from '../scripts/prebuild'

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

  it('validates the checked-in internal plugin manifest', () => {
    const manifest = validateManifest()
    expect(manifest).toHaveLength(5)
    expect(manifest.every(plugin => plugin.integrity?.startsWith('sha512-'))).toBe(true)
  })
})
