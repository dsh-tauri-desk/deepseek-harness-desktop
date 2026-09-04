import type { PetSessionEvent } from '../types'
import { describe, expect, it } from 'vitest'
import { activityBubble, describePending, describeSession, mapPetActivity, sessionTitle } from './activity'
import { createSessionStatus, reduceSessionEvent } from './session-status'

function event(type: string, data: Record<string, unknown> = {}, seq = 1): PetSessionEvent {
  return { type, data, seq }
}

const text = (key: string) => key

describe('mapPetActivity', () => {
  it('follows the Codex reference state precedence', () => {
    const summary = { id: 'session', running: true, completed: true }
    const session = { running: true, lastAgentError: 'boom' }
    expect(mapPetActivity(summary, session, { kind: 'question' })).toBe('waiting')
    expect(mapPetActivity({ ...summary, completed: false }, { ...session, lastAgentError: 'boom' }, undefined)).toBe('running')
    expect(mapPetActivity({ ...summary, completed: false }, { ...session, lastAgentError: null }, undefined)).toBe('running')
    expect(mapPetActivity({ ...summary, completed: false }, { ...session, lastAgentError: null }, { kind: 'question' })).toBe('waiting')
    expect(mapPetActivity({ ...summary, running: false }, { ...session, running: false, lastAgentError: null }, undefined)).toBe('review')
    expect(mapPetActivity({ id: 'session' }, { running: false, lastAgentError: 'boom' }, undefined)).toBe('failed')
    expect(mapPetActivity({ id: 'session' }, { running: false, lastAgentError: null }, undefined)).toBe('idle')
  })
})

describe('activityBubble', () => {
  it('includes context for non-idle states and clears idle bubbles', () => {
    expect(activityBubble('running', 'Running', 'Fix tests')).toBe('Running: Fix tests')
    expect(activityBubble('waiting', 'Waiting')).toBe('Waiting')
    expect(activityBubble('idle', 'Idle', 'Done')).toBeUndefined()
  })

  it('truncates long Unicode titles to the bridge-safe bubble limit', () => {
    const bubble = activityBubble('running', '运行中', '鲸'.repeat(200))
    expect(Array.from(bubble ?? '')).toHaveLength(120)
    expect(bubble?.startsWith('运行中: ')).toBe(true)
  })
})

describe('sessionTitle', () => {
  it('uses the session title and falls back to the label', () => {
    expect(sessionTitle('Fix tests', 'Running')).toBe('Fix tests')
    expect(sessionTitle('  ', 'Running')).toBe('Running')
    expect(sessionTitle(undefined, 'Waiting')).toBe('Waiting')
  })
})

describe('describeSession', () => {
  it('maps each phase to its copy', () => {
    const run = (type: string, data: Record<string, unknown> = {}, seq = 1) =>
      reduceSessionEvent(createSessionStatus(), event(type, data, seq))

    expect(describeSession(run('turn/start'), text)).toBe('activityPreparing')
    expect(describeSession(run('tool/call', { name: 'Pwsh', callId: 'c1' }, 10), text)).toBe('activityWorking · toolPrefix Pwsh')
    expect(describeSession(run('tool/result', { callId: 'c1' }, 11), text)).toBe('activityResult')
    expect(describeSession(run('approval/asked', { id: 'a1' }, 12), text)).toBe('activityApproval')
    expect(describeSession(run('turn/end', { reason: { kind: 'completed' } }, 13), text)).toBe('activityReview')
  })
})

describe('describePending', () => {
  it('maps decision kinds to copy', () => {
    expect(describePending('approval', text)).toBe('activityApproval')
    expect(describePending('plan-review', text)).toBe('pendingPlanReview')
    expect(describePending('question', text)).toBe('pendingQuestion')
    expect(describePending('user-question', text)).toBe('activityWaiting')
    expect(describePending(undefined, text)).toBe('activityWaiting')
  })
})
