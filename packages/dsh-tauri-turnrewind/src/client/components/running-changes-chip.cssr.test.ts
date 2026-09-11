import { describe, expect, it, vi } from 'vitest'

import countsStyle from '../styles/counts.cssr'
import chipStyle from './running-changes-chip.cssr'

vi.mock('dsh-tauri-ui/client', async () => {
  const mod = await import('../../../../dsh-tauri-ui/src/client/utils/cssr.ts')
  return { cssr: mod.cssr }
})

describe('running-changes-chip.cssr', () => {
  const css = chipStyle.render()

  it('输入框上方居中胶囊（不拦点击，只有胶囊本身可交互）', () => {
    expect(css).toMatch(/\.dshp-turnrewind-running\s*\{[^}]*justify-content: center/)
    expect(css).toMatch(/\.dshp-turnrewind-running\s*\{[^}]*pointer-events: none/)
    expect(css).toMatch(/\.dshp-turnrewind-running__chip\s*\{[^}]*pointer-events: auto/)
    expect(css).toMatch(/\.dshp-turnrewind-running__chip\s*\{[^}]*border-radius: 10px/)
    expect(css).toMatch(/\.dshp-turnrewind-running__chip\s*\{[^}]*background: var\(--dsw-alias-bg-base/)
  })
})

describe('counts.cssr', () => {
  const css = countsStyle.render()

  it('+N 绿、-M 红（与官方 deliverables 行同款配色）', () => {
    expect(css).toMatch(/\.dshp-turnrewind-counts__add\s*\{[^}]*color: var\(--dsw-alias-state-success-primary/)
    expect(css).toMatch(/\.dshp-turnrewind-counts__del\s*\{[^}]*color: var\(--dsw-alias-state-error-primary/)
    expect(css).toMatch(/\.dshp-turnrewind-counts__binary\s*\{[^}]*color: var\(--dsw-alias-label-secondary/)
  })
})
