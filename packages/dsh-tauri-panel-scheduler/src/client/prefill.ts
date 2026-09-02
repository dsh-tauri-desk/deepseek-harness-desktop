/** 面板「通过 Chat 创建」交给会话输入框的待填草稿（照搬 dsh-automation prefill.ts）。 */

let pending: string | null = null
const listeners = new Set<(text: string | null) => void>()

export function setChatPrefill(text: string): void {
  pending = text
  for (const listener of [...listeners]) listener(pending)
}

export function takeChatPrefill(): string | null {
  const value = pending
  pending = null
  return value
}

export function peekChatPrefill(): string | null {
  return pending
}

export function subscribeChatPrefill(listener: (text: string | null) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function applyPrefillToDom(text: string): boolean {
  const seat = document.querySelector('[data-composer-seat] textarea')
  if (!(seat instanceof HTMLTextAreaElement))
    return false
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
  descriptor?.set?.call(seat, text)
  seat.dispatchEvent(new InputEvent('input', { bubbles: true }))
  seat.focus()
  return true
}
