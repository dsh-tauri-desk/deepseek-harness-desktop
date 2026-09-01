/**
 * utils/editable.ts — 可编辑元素 / 内容面的选区操作（纯 DOM 逻辑，可独立测试）。
 *
 * 从 menu.ts 拆出的三态选区能力：input / textarea 走 selectionStart/End，
 * contenteditable 走 Selection/Range；「全选内容区」针对对话正文 / 设置弹窗 /
 * hero 首屏三类表面。不含菜单装配与生命周期职责。
 */
import { text } from '../locales'

/** 替换可编辑元素中的当前选区（输入/文本域/可编辑区三态）。 */
export function replaceSelection(editable: HTMLElement, value: string): void {
  editable.focus()
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const start = editable.selectionStart ?? editable.value.length
    const end = editable.selectionEnd ?? start
    editable.setRangeText(value, start, end, 'end')
    editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    return
  }
  const selection = globalThis.getSelection()
  if (!selection?.rangeCount || !editable.contains(selection.anchorNode))
    throw new Error(text('editPositionUnknown'))
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const textNode = document.createTextNode(value)
  range.insertNode(textNode)
  range.setStartAfter(textNode)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
}

/** 全选某个内容面（Range.selectNodeContents）。 */
export function selectSurface(surface: HTMLElement): void {
  if (!surface)
    return
  const selection = globalThis.getSelection()
  if (!selection)
    return
  const range = document.createRange()
  range.selectNodeContents(surface)
  selection.removeAllRanges()
  selection.addRange(range)
}

/** 全选的可编辑目标（输入/文本域直接 select()，可编辑区走内容面全选）。 */
export function selectAll(editable: HTMLElement): void {
  editable.focus()
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement)
    editable.select()
  else
    selectSurface(editable)
}

/** 全选的会话内容区（对话正文 / 设置弹窗 / hero 首屏）。 */
export function selectionSurface(target: unknown): HTMLElement | null {
  if (target instanceof Element) {
    const conversation = target.closest<HTMLElement>('[data-slot="conversation.session"]')
    if (conversation)
      return conversation
    const dialog = target.closest<HTMLElement>('[role="dialog"]')
    if (dialog)
      return dialog
    const hero = target.closest<HTMLElement>('[data-phase="hero"]')
    if (hero?.querySelector(':scope > [data-conversation-scroll]'))
      return hero
  }
  return null
}
