import type { ZoomShortcutLike } from './zoom'
import { describe, expect, it } from 'vitest'
import { zoomActionFromShortcut } from './zoom'

function shortcut(
  key: string,
  modifiers: Partial<ZoomShortcutLike> = {},
): ZoomShortcutLike {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  }
}

describe('client zoom shortcuts', () => {
  it('maps Ctrl and Command zoom keys', () => {
    expect(zoomActionFromShortcut(shortcut('+', { ctrlKey: true }))).toBe('increase')
    expect(zoomActionFromShortcut(shortcut('=', { metaKey: true }))).toBe('increase')
    expect(zoomActionFromShortcut(shortcut('-', { ctrlKey: true }))).toBe('decrease')
    expect(zoomActionFromShortcut(shortcut('_', { metaKey: true }))).toBe('decrease')
    expect(zoomActionFromShortcut(shortcut('0', { ctrlKey: true }))).toBe('reset')
  })

  it('rejects unmodified, AltGr-like and unrelated keys', () => {
    expect(zoomActionFromShortcut(shortcut('+'))).toBeNull()
    expect(zoomActionFromShortcut(shortcut('+', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(zoomActionFromShortcut(shortcut('1', { ctrlKey: true }))).toBeNull()
  })
})
