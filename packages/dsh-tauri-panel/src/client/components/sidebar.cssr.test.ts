import { describe, expect, it, vi } from 'vitest'

import sidebarStyle from './sidebar.cssr'

// dsh-tauri-ui/client 的 dist bundle 以 `window.__ModuleLoader__.load(...)` 包裹，
// 脱离宿主加载器后无法在 node 环境求值；把该导入 mock 到同一 cssr 实例的源文件
// （cssr.ts），使本包的样式树能在测试里直接 render() 核对选择器形态。
// （vitest 会提升 vi.mock，声明位置在 import 之后也无碍。）
vi.mock('dsh-tauri-ui/client', async () => {
  const mod = await import('../../../../dsh-tauri-ui/src/client/utils/cssr.ts')
  return { cssr: mod.cssr }
})

describe('sidebar.cssr new-session（回归：白底 + 圆角的官方按钮形态）', () => {
  const sidebarCss = sidebarStyle.render()

  it('基态自给自足：镜像官方 ui-sidebar New Session 按钮（elevated-fill 白底、12px 圆角、38px、500 字重、.5px l3 描边）', () => {
    const base = /\.dshp-panel \.dshp-panel__new-session\s*\{[^}]*\}/
    const baseBody = sidebarCss.match(base)?.[0] ?? ''
    expect(baseBody).toContain('background: var(--dsw-alias-button-elevated-fill)')
    expect(baseBody).toContain('border-radius: 12px')
    expect(baseBody).toContain('height: 38px')
    expect(baseBody).toContain('font-weight: 500')
    expect(baseBody).toContain('border: .5px solid var(--dsw-alias-border-l3)')
  })

  it('不依赖 .dshp-panel__menu-item 提供按钮基座：display:flex 等交互基座自含，折叠态规则仍生效', () => {
    const base = /\.dshp-panel \.dshp-panel__new-session\s*\{[^}]*\}/
    const baseBody = sidebarCss.match(base)?.[0] ?? ''
    expect(baseBody).toContain('display: flex')
    expect(baseBody).toContain('cursor: pointer')
    expect(sidebarCss).toMatch(/\.dshp-panel\.dshp-panel--collapsed \.dshp-panel__new-session\s*\{[^}]*width: 36px[^}]*\}/)
  })
})
