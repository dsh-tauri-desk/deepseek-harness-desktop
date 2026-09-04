import { describe, expect, it } from 'vitest'
import {
  beginDrag,
  createDragMachine,
  dragSample,
  hasDragged,
  isDragActive,
} from './drag-machine'

describe('drag machine lifecycle', () => {
  it('starts from idle and enters starting on begin', () => {
    expect(createDragMachine().phase).toBe('idle')
    const started = beginDrag('left')
    expect(started.phase).toBe('starting')
    expect(started.facing).toBe('left')
    expect(started.anchorX).toBeNull()
  })

  it('reports active only while starting or dragging', () => {
    const idle = createDragMachine()
    expect(isDragActive(idle)).toBe(false)
    const started = beginDrag('left')
    expect(isDragActive(started)).toBe(true)
    const dragged = dragSample(started, 90)
    expect(isDragActive(dragged)).toBe(true)
  })
})

describe('dragSample direction', () => {
  it('records anchor on first sample without changing direction', () => {
    const started = beginDrag('left')
    const first = dragSample(started, 100)
    expect(first.phase).toBe('starting')
    expect(first.anchorX).toBe(100)
    expect(first.facing).toBe('left')
  })

  it('ignores sub-threshold jitter and keeps direction', () => {
    let machine = beginDrag('left')
    machine = dragSample(machine, 100)
    machine = dragSample(machine, 101)
    expect(machine.phase).toBe('starting')
    expect(machine.facing).toBe('left')
    expect(machine.anchorX).toBe(100)
  })

  it('commits direction once displacement crosses threshold', () => {
    let machine = beginDrag('left')
    machine = dragSample(machine, 100)
    machine = dragSample(machine, 120)
    expect(machine.phase).toBe('dragging')
    expect(machine.facing).toBe('right')
    expect(hasDragged(machine)).toBe(true)
  })

  it('switches direction on a large reverse move', () => {
    let machine = beginDrag('left')
    machine = dragSample(machine, 100)
    machine = dragSample(machine, 140)
    expect(machine.facing).toBe('right')
    machine = dragSample(machine, 80)
    expect(machine.facing).toBe('left')
  })
})
