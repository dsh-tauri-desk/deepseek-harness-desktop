/**
 * worktree.test.ts — worktree.ts 纯函数单测（resolveAccessModeGroup）。
 *
 * 用轻量结构替身（只含 parentElement / contains）模拟官方 composer .modes 布局：
 * 访问模式按钮被包在 Menu root span 里，祖父才是 .modes 分组（含 plan 槽位）。
 * 不依赖 jsdom，在默认 node 环境即可运行。
 */
import { describe, expect, it } from 'vitest'
import { resolveAccessModeGroup } from './worktree'

interface NodeStub {
  parentElement: NodeStub | null
  contains: (other: unknown) => boolean
}

/** 构造 `button ∈ Menu-root-span ∈ .modes(含 planSlot)` 的最小骨架。 */
function buildModesSkeleton(): { modes: NodeStub, menuRoot: NodeStub, button: NodeStub, planSlot: NodeStub } {
  const modes: NodeStub = { parentElement: null, contains: () => false }
  const menuRoot: NodeStub = { parentElement: modes, contains: () => false }
  const button: NodeStub = { parentElement: menuRoot, contains: () => false }
  const planSlot: NodeStub = { parentElement: modes, contains: () => false }
  // .modes 能包含 plan 槽位与 button（向上找到自身即可命中）。
  modes.contains = other => other === planSlot || other === menuRoot
  return { modes, menuRoot, button, planSlot }
}

describe('resolveAccessModeGroup', () => {
  it('从访问模式按钮向上定位到包含 plan 槽位的 .modes 分组（而非 Menu root span）', () => {
    const { modes, button, planSlot } = buildModesSkeleton()
    // 目标须为能包含 plan 槽位的公共父节点：第二层（button → menuRoot → modes）触发 contains 命中。
    const target = resolveAccessModeGroup(button as unknown as HTMLElement, planSlot as unknown as Element)
    expect(target).toBe(modes as unknown as HTMLElement)
  })

  it('plan 槽位缺失（alpha 变体）时退回 Menu root span 的父节点', () => {
    const { modes, button } = buildModesSkeleton()
    const target = resolveAccessModeGroup(button as unknown as HTMLElement, null)
    expect(target).toBe(modes as unknown as HTMLElement)
  })

  it('按钮悬浮（向上链路断）时回退返回按钮本身，控件不消失', () => {
    const button: NodeStub = { parentElement: null, contains: () => false }
    const target = resolveAccessModeGroup(button as unknown as HTMLElement, null)
    expect(target).toBe(button as unknown as HTMLElement)
  })

  it('超过 maxDepth 仍未命中时回退返回按钮本身', () => {
    const { button, planSlot } = buildModesSkeleton()
    // 从 button 直达 .modes 需 2 层；maxDepth=1 使循环提前退出，回退按钮本身。
    const target = resolveAccessModeGroup(button as unknown as HTMLElement, planSlot as unknown as Element, 1)
    expect(target).toBe(button as unknown as HTMLElement)
  })
})
