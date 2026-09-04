import { describe, expect, it } from 'vitest'
import { createSessionBubbleStore, sessionBubbleDescription, sessionBubbleTitle } from './session-bubbles'

describe('sessionBubbleTitle', () => {
  it('uses trimmed bubble title when present', () => {
    expect(sessionBubbleTitle({ activity: 'running', bubble: '  Fix tests  ' })).toBe('Fix tests')
  })

  it('falls back to activity when bubble missing', () => {
    expect(sessionBubbleTitle({ activity: 'review' })).toBe('review')
  })

  it('falls back to working when unknown activity', () => {
    expect(sessionBubbleTitle({ bubble: '' })).toBe('working')
  })
})

describe('sessionBubbleDescription', () => {
  it('uses the live description field', () => {
    expect(sessionBubbleDescription({ activity: 'running', description: '正在思考…' })).toBe('正在思考…')
  })

  it('falls back to the title when description missing', () => {
    expect(sessionBubbleDescription({ activity: 'waiting', bubble: '会话A' })).toBe('会话A')
  })

  it('extracts description from object bubble', () => {
    expect(sessionBubbleDescription({ activity: 'running', description: { text: '工具 Pwsh' } })).toBe('工具 Pwsh')
  })
})

describe('sessionBubbleStore', () => {
  it('keeps snapshot stable unless a value changes', () => {
    const store = createSessionBubbleStore()
    const before = store.getSnapshot()
    expect(store.get('a')).toBeUndefined()
    store.set('a', '思考中')
    expect(store.get('a')).toBe('思考中')
    expect(store.getSnapshot()).toBe(before + 1)
    store.set('a', '思考中')
    expect(store.getSnapshot()).toBe(before + 1)
    store.delete('a')
    expect(store.get('a')).toBeUndefined()
    expect(store.getSnapshot()).toBe(before + 2)
  })

  it('notifies listeners only on actual changes', () => {
    const store = createSessionBubbleStore()
    let notified = 0
    const unsubscribe = store.subscribe(() => {
      notified += 1
    })
    store.set('s1', 'a')
    store.set('s1', 'a')
    store.set('s1', 'b')
    store.delete('s1')
    store.delete('s1')
    unsubscribe()
    store.set('s2', 'c')
    expect(notified).toBe(3)
  })
})
