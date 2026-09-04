import type { PetSessionEvent } from '../types'
import { describe, expect, it } from 'vitest'
import {
  createSessionStatus,
  isUserQuestionTool,
  phaseToActivity,
  reduceSessionEvent,
  toolCallIdOf,
} from './session-status'

function event(type: string, data: Record<string, unknown> = {}, seq = 1): PetSessionEvent {
  return { type, data, seq }
}

describe('phaseToActivity', () => {
  it('maps thinking/working to running, waiting to waiting, etc.', () => {
    expect(phaseToActivity('preparing')).toBe('running')
    expect(phaseToActivity('thinking')).toBe('running')
    expect(phaseToActivity('working')).toBe('running')
    expect(phaseToActivity('waiting')).toBe('waiting')
    expect(phaseToActivity('review')).toBe('review')
    expect(phaseToActivity('failed')).toBe('failed')
    expect(phaseToActivity('idle')).toBe('idle')
    expect(phaseToActivity('stopped')).toBe('idle')
  })
})

describe('reduceSessionEvent', () => {
  it('turn/start prepares the turn', () => {
    const state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    expect(state.phase).toBe('preparing')
    expect(state.turnActive).toBe(true)
    expect(state.activity).toBe('running')
  })

  it('tool/call enters working with the tool name', () => {
    let state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    state = reduceSessionEvent(state, event('tool/call', { name: 'Pwsh', callId: 'c1' }, 2))
    expect(state.phase).toBe('working')
    expect(state.toolName).toBe('Pwsh')
    expect(state.activity).toBe('running')
  })

  it('tool/result resumes to result (整理) when no tools remain open', () => {
    let state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    state = reduceSessionEvent(state, event('tool/call', { name: 'Pwsh', callId: 'c1' }, 2))
    state = reduceSessionEvent(state, event('tool/result', { callId: 'c1' }, 3))
    expect(state.phase).toBe('result')
    expect(state.toolName).toBeUndefined()
  })

  it('user-question tool enters waiting', () => {
    let state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    state = reduceSessionEvent(state, event('tool/call', { name: 'ask_user_question', callId: 'q1' }, 2))
    expect(state.phase).toBe('waiting')
    expect(state.activity).toBe('waiting')
  })

  it('approval/asked enters waiting with approval kind', () => {
    let state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    state = reduceSessionEvent(state, event('approval/asked', { id: 'a1', toolName: 'node' }, 2))
    expect(state.phase).toBe('waiting')
    expect(state.pendingKind).toBe('approval')
    expect(state.activity).toBe('waiting')
  })

  it('turn/end completed settles to review', () => {
    let state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    state = reduceSessionEvent(state, event('turn/end', { reason: { kind: 'completed' } }, 2))
    expect(state.phase).toBe('review')
    expect(state.activity).toBe('review')
  })

  it('turn/end blocked stays waiting, aborted stops, other reason fails', () => {
    let state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    state = reduceSessionEvent(state, event('turn/end', { reason: { kind: 'blocked' } }, 2))
    expect(state.phase).toBe('waiting')

    state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    state = reduceSessionEvent(state, event('turn/end', { reason: { kind: 'aborted' } }, 2))
    expect(state.phase).toBe('stopped')

    state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    state = reduceSessionEvent(state, event('turn/end', { reason: { kind: 'max-tokens' } }, 2))
    expect(state.phase).toBe('failed')
  })

  it('replaying an already-consumed seq is a no-op', () => {
    let state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    state = reduceSessionEvent(state, event('tool/call', { name: 'Pwsh', callId: 'c1' }, 2))
    const after = reduceSessionEvent(state, event('tool/call', { name: 'Pwsh', callId: 'c1' }, 2))
    expect(after).toBe(state)
  })

  it('a held turn does not flicker to idle between tool calls', () => {
    // 两次 tool/call 之间有 tool/result，但 turn 尚未 end，应保持 running。
    let state = reduceSessionEvent(createSessionStatus(), event('turn/start', {}, 1))
    state = reduceSessionEvent(state, event('tool/call', { name: 'read', callId: 'c1' }, 2))
    state = reduceSessionEvent(state, event('tool/result', { callId: 'c1' }, 3))
    expect(state.activity).toBe('running')
    expect(state.phase).toBe('result')
  })
})

describe('toolCallIdOf', () => {
  it('reads callId from message.source.callId, then message.toolCallId, then data.callId', () => {
    expect(toolCallIdOf(event('tool/call', { message: { source: { callId: 'x' } } }))).toBe('x')
    expect(toolCallIdOf(event('tool/call', { message: { toolCallId: 'y' } }))).toBe('y')
    expect(toolCallIdOf(event('tool/call', { callId: 'z' }))).toBe('z')
    expect(toolCallIdOf(event('tool/call', {}), 'fb')).toBe('fb')
  })
})

describe('isUserQuestionTool', () => {
  it('flags only true question/approval tools', () => {
    expect(isUserQuestionTool('ask_user_question')).toBe(true)
    expect(isUserQuestionTool('exit_plan_mode')).toBe(true)
    expect(isUserQuestionTool('request_user_input')).toBe(true)
    expect(isUserQuestionTool('code_review')).toBe(false)
    expect(isUserQuestionTool('allowlist_files')).toBe(false)
    expect(isUserQuestionTool('search')).toBe(false)
  })
})
