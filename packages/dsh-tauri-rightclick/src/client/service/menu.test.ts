import { describe, expect, it, vi } from 'vitest'
import { postOpenPath } from '../apis'
import { openInExplorer } from './menu'

vi.mock('../apis', () => ({ postOpenPath: vi.fn() }))

/** 只替代表达层：locale 的真身经 `dsh-tauri/client` 拉入浏览器运行时，node 下无法加载。 */
vi.mock('../locales', () => ({
  locale: {
    text: (key: string, params: Record<string, unknown> = {}) =>
      params.reason ? `${key}: ${params.reason}` : key,
  },
}))

/** `dsh-tauri/client` 的真身是浏览器 bundle，node 下无法加载；此处只补被测路径涉及的 lodash helpers。 */
vi.mock('dsh-tauri/client', async () => {
  const lodash = await import('lodash-es')
  return {
    difference: lodash.difference,
    filter: lodash.filter,
    get: lodash.get,
  }
})

const postOpenPathMock = vi.mocked(postOpenPath)

describe('openInExplorer', () => {
  it('posts the directory to the plugin-owned open-path route', async () => {
    postOpenPathMock.mockResolvedValue({ ok: true })

    await expect(openInExplorer({ path: 'C:\\workspace' })).resolves.toEqual({ ok: true })
    expect(postOpenPathMock).toHaveBeenCalledWith({ path: 'C:\\workspace' })
  })

  it('surfaces the route error instead of a JSON SyntaxError', async () => {
    postOpenPathMock.mockResolvedValue({ ok: false, error: 'not-a-directory' })

    const outcome = await openInExplorer({ path: 'C:\\workspace' })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/openFailed: not-a-directory/)
  })

  it('falls back to the generic error when the route reports no detail', async () => {
    postOpenPathMock.mockResolvedValue({ ok: false })

    const outcome = await openInExplorer({ path: 'C:\\workspace' })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/openFailed: unknownError/)
  })
})
