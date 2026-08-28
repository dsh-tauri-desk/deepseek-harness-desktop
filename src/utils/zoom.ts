export type ZoomAction = 'increase' | 'decrease' | 'reset'

export interface ZoomShortcutLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

interface ZoomBridgeMessage {
  source: 'dsh-zoom-shortcut-bridge'
  type: 'dsh://zoom-shortcut'
  action: ZoomAction
}

export function zoomActionFromShortcut(shortcut: ZoomShortcutLike): ZoomAction | null {
  if ((!shortcut.ctrlKey && !shortcut.metaKey) || shortcut.altKey)
    return null

  if (shortcut.key === '+' || shortcut.key === '=')
    return 'increase'
  if (shortcut.key === '-' || shortcut.key === '_')
    return 'decrease'
  if (shortcut.key === '0')
    return 'reset'
  return null
}

export function zoomActionFromBridgeMessage(value: unknown): ZoomAction | null {
  if (!value || typeof value !== 'object')
    return null

  const message = value as Partial<ZoomBridgeMessage>
  if (message.source !== 'dsh-zoom-shortcut-bridge' || message.type !== 'dsh://zoom-shortcut')
    return null
  if (message.action === 'increase' || message.action === 'decrease' || message.action === 'reset')
    return message.action
  return null
}
