import { describe, expect, it, vi } from 'vitest'
import {
  addDraftAttachments,
  draftAttachmentIds,
  NO_DRAFT_ATTACHMENTS,
  removeDraftAttachment,
  resolveAccessModeGroup,
} from './mode-select.utils'

describe('draftAttachmentIds', () => {
  it('prefers the alpha attachmentIds field', () => {
    expect(draftAttachmentIds({ draft: '', attachmentIds: ['a'] })).toEqual(['a'])
  })

  it('falls back to the legacy imageIds field', () => {
    expect(draftAttachmentIds({ draft: '', imageIds: ['b'] })).toEqual(['b'])
  })

  it('returns a stable empty array when neither field is present', () => {
    const first = draftAttachmentIds({ draft: '' })
    const second = draftAttachmentIds(undefined)
    expect(first).toBe(NO_DRAFT_ATTACHMENTS)
    expect(second).toBe(NO_DRAFT_ATTACHMENTS)
    expect(first.length).toBe(0)
  })
})

describe('addDraftAttachments', () => {
  it('uses addAttachments when the alpha action face is present', () => {
    const addAttachments = vi.fn(() => true)
    const addImages = vi.fn(() => true)
    expect(addDraftAttachments({ setDraft: vi.fn(), submit: vi.fn(), addAttachments, addImages }, ['a'])).toBe(true)
    expect(addAttachments).toHaveBeenCalledWith(['a'])
    expect(addImages).not.toHaveBeenCalled()
  })

  it('uses the legacy addImages action when addAttachments is absent', () => {
    const addImages = vi.fn(() => true)
    expect(addDraftAttachments({ setDraft: vi.fn(), submit: vi.fn(), addImages }, ['a'])).toBe(true)
    expect(addImages).toHaveBeenCalledWith(['a'])
  })

  it('is a no-op success without attachments and a failure when the action face is missing', () => {
    expect(addDraftAttachments({ setDraft: vi.fn(), submit: vi.fn() }, [])).toBe(true)
    expect(addDraftAttachments({ setDraft: vi.fn(), submit: vi.fn() }, ['a'])).toBe(false)
    expect(addDraftAttachments(undefined, ['a'])).toBe(false)
  })
})

describe('removeDraftAttachment', () => {
  it('prefers removeAttachment over the legacy removeImage', () => {
    const removeAttachment = vi.fn()
    const removeImage = vi.fn()
    removeDraftAttachment({ setDraft: vi.fn(), submit: vi.fn(), removeAttachment, removeImage }, 'a')
    expect(removeAttachment).toHaveBeenCalledWith('a')
    expect(removeImage).not.toHaveBeenCalled()
  })

  it('falls back to removeImage and tolerates a missing action face', () => {
    const removeImage = vi.fn()
    removeDraftAttachment({ setDraft: vi.fn(), submit: vi.fn(), removeImage }, 'a')
    expect(removeImage).toHaveBeenCalledWith('a')
    expect(() => removeDraftAttachment(undefined, 'a')).not.toThrow()
  })
})

interface NodeStub {
  parentElement: NodeStub | null
  contains: (other: unknown) => boolean
}

function buildModesSkeleton(): { modes: NodeStub, menuRoot: NodeStub, button: NodeStub, planSlot: NodeStub } {
  const modes: NodeStub = { parentElement: null, contains: () => false }
  const menuRoot: NodeStub = { parentElement: modes, contains: () => false }
  const button: NodeStub = { parentElement: menuRoot, contains: () => false }
  const planSlot: NodeStub = { parentElement: modes, contains: () => false }
  modes.contains = other => other === planSlot || other === menuRoot
  return { modes, menuRoot, button, planSlot }
}

describe('resolveAccessModeGroup', () => {
  it('从访问模式按钮向上定位到包含 plan 槽位的 .modes 分组（而非 Menu root span）', () => {
    const { modes, button, planSlot } = buildModesSkeleton()
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
    const target = resolveAccessModeGroup(button as unknown as HTMLElement, planSlot as unknown as Element, 1)
    expect(target).toBe(button as unknown as HTMLElement)
  })
})
