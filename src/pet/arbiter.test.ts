import { describe, expect, it } from 'vitest'
import { dragFacing, isCurrentPetGeneration, resolvePetActivity } from './arbiter'

describe('resolvePetActivity', () => {
  it('lets dragging override every session state while actively dragging', () => {
    for (const sessionActivity of ['idle', 'waiting', 'running', 'review', 'failed'] as const) {
      expect(resolvePetActivity({ sessionActivity, draggingActivity: 'moving-right', interactionActivity: null })).toBe('moving-right')
    }
  })

  it('restores the non-idle session state once dragging stops', () => {
    for (const sessionActivity of ['waiting', 'running', 'review', 'failed'] as const) {
      expect(resolvePetActivity({ sessionActivity, draggingActivity: null, interactionActivity: null })).toBe(sessionActivity)
    }
  })

  it('keeps a non-idle session above a local interaction', () => {
    expect(resolvePetActivity({ sessionActivity: 'waiting', draggingActivity: null, interactionActivity: 'waving' })).toBe('waiting')
  })

  it('falls back to interaction then idle only while session is idle and not dragging', () => {
    expect(resolvePetActivity({ sessionActivity: 'idle', draggingActivity: 'moving-left', interactionActivity: 'waving' })).toBe('moving-left')
    expect(resolvePetActivity({ sessionActivity: 'idle', draggingActivity: null, interactionActivity: 'waving' })).toBe('waving')
    expect(resolvePetActivity({ sessionActivity: 'idle', draggingActivity: null, interactionActivity: null })).toBe('idle')
  })
})

describe('dragFacing', () => {
  it('uses adjacent physical x positions', () => {
    expect(dragFacing(100, 90, 'right')).toBe('left')
    expect(dragFacing(100, 110, 'left')).toBe('right')
    expect(dragFacing(100, 100, 'left')).toBe('left')
  })

  it('keeps current direction when displacement is below jitter threshold', () => {
    expect(dragFacing(100, 102, 'right', 4)).toBe('right')
    expect(dragFacing(100, 98, 'left', 4)).toBe('left')
    expect(dragFacing(100, 105, 'left', 4)).toBe('right')
  })
})

describe('isCurrentPetGeneration', () => {
  it('rejects stale completion callbacks', () => {
    expect(isCurrentPetGeneration(2, 1)).toBe(false)
    expect(isCurrentPetGeneration(2, 2)).toBe(true)
  })
})
