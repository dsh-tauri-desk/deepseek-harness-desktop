import { describe, expect, it } from 'vitest'
import { zoomActionFromBridgeMessage, zoomActionFromShortcut } from '../src/utils/zoom'

function shortcut(
  key: string,
  modifiers: Partial<Omit<KeyboardEvent, 'key'>> = {},
) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  }
}

describe('desktop zoom shortcuts', () => {
  it('maps Ctrl and Command zoom shortcuts', () => {
    expect(zoomActionFromShortcut(shortcut('+', { ctrlKey: true }))).toBe('increase')
    expect(zoomActionFromShortcut(shortcut('=', { metaKey: true }))).toBe('increase')
    expect(zoomActionFromShortcut(shortcut('-', { ctrlKey: true }))).toBe('decrease')
    expect(zoomActionFromShortcut(shortcut('_', { metaKey: true }))).toBe('decrease')
    expect(zoomActionFromShortcut(shortcut('0', { ctrlKey: true }))).toBe('reset')
  })

  it('rejects unmodified, AltGr-like, and unrelated shortcuts', () => {
    expect(zoomActionFromShortcut(shortcut('+'))).toBeNull()
    expect(zoomActionFromShortcut(shortcut('+', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(zoomActionFromShortcut(shortcut('1', { ctrlKey: true }))).toBeNull()
  })

  it('accepts only the strict iframe bridge protocol', () => {
    expect(zoomActionFromBridgeMessage({
      source: 'dsh-zoom-shortcut-bridge',
      type: 'dsh://zoom-shortcut',
      action: 'increase',
    })).toBe('increase')
    expect(zoomActionFromBridgeMessage({
      source: 'other-frame',
      type: 'dsh://zoom-shortcut',
      action: 'increase',
    })).toBeNull()
    expect(zoomActionFromBridgeMessage({
      source: 'dsh-zoom-shortcut-bridge',
      type: 'dsh://zoom-shortcut',
      action: 'unsupported',
    })).toBeNull()
    expect(zoomActionFromBridgeMessage(null)).toBeNull()
  })
})
