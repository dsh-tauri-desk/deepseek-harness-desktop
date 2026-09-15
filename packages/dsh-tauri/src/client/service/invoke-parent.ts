import type { ParentMessage } from '../types/iframe'

export function invokeParent(message: ParentMessage) {
  if (typeof window === 'undefined' || window.parent === window)
    throw new Error('NO_HOST: parent window is not available')
  try {
    window.parent.postMessage(message, '*')
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error }
  }
}
