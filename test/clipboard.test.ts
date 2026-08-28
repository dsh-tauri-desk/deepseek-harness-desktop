import { readFileSync } from 'node:fs'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboardText } from '../src/utils/clipboard'

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(),
}))

const CLIPBOARD_CALL_SITES = [
  '../src/components/config-debug.tsx',
  '../src/layout/components/navbar.tsx',
  '../src/layout/components/preinstall-setup.tsx',
]

describe('clipboard integration', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('routes every shell copy action through the native helper and handles failures', () => {
    for (const path of CLIPBOARD_CALL_SITES) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      expect(source).not.toContain('navigator.clipboard.writeText')

      const nativeWrite = source.indexOf('writeClipboardText(')
      expect(nativeWrite).toBeGreaterThan(-1)

      const failurePath = source.slice(nativeWrite, nativeWrite + 500)
      expect(failurePath).toContain('catch (err)')
      expect(failurePath).toContain('messages.logs_copy_failed')
    }
  })

  it('writes the exact text through the native clipboard plugin', async () => {
    vi.mocked(writeText).mockResolvedValue()

    await expect(writeClipboardText('diagnostic logs')).resolves.toBeUndefined()

    expect(writeText).toHaveBeenCalledExactlyOnceWith('diagnostic logs')
  })

  it('propagates native clipboard failures to the caller', async () => {
    const failure = new Error('clipboard unavailable')
    vi.mocked(writeText).mockRejectedValue(failure)

    await expect(writeClipboardText('diagnostic logs')).rejects.toBe(failure)
  })
})
