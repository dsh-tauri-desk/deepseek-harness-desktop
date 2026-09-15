import type { InputActions, InputState } from '../service/session-switch.types'

export const NO_DRAFT_ATTACHMENTS: readonly string[] = []

export function draftAttachmentIds(state: InputState | undefined): readonly string[] {
  return state?.attachmentIds ?? state?.imageIds ?? NO_DRAFT_ATTACHMENTS
}

export function addDraftAttachments(actions: InputActions | undefined, ids: readonly string[]): boolean {
  if (ids.length === 0)
    return true
  if (typeof actions?.addAttachments === 'function')
    return actions.addAttachments([...ids])
  if (typeof actions?.addImages === 'function')
    return actions.addImages([...ids])
  return false
}

export function removeDraftAttachment(actions: InputActions | undefined, id: string): void {
  if (typeof actions?.removeAttachment === 'function') {
    actions.removeAttachment(id)
    return
  }
  actions?.removeImage?.(id)
}

export function resolveAccessModeGroup(button: HTMLElement, planSlot: Element | null, maxDepth = 8): HTMLElement {
  let previous: HTMLElement = button
  let node: HTMLElement | null = button.parentElement
  for (let depth = 0; node && depth < maxDepth; depth++) {
    if (planSlot ? node.contains(planSlot) : previous !== button)
      return node
    previous = node
    node = node.parentElement
  }
  return button
}
