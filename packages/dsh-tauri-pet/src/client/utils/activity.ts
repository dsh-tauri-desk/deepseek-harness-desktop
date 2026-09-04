import type { PetSessionActivity, PetSessionSnapshot, PetSessionSummary } from '../types'
import type { SessionStatusRecord } from './session-status'
import { PET_ACTIVITY_BUBBLE_MAX } from '../constants'
import { phaseToActivity } from './session-status'

/** Map the Codex reference precedence to the desktop animation protocol. */
export function mapPetActivity(
  summary: PetSessionSummary | undefined,
  session: PetSessionSnapshot | undefined,
  pendingInteraction: unknown,
): PetSessionActivity {
  if (pendingInteraction !== undefined)
    return 'waiting'
  if (summary?.running === true || session?.running === true)
    return 'running'
  if (summary?.completed === true)
    return 'review'
  if (session?.lastAgentError !== null && session?.lastAgentError !== undefined)
    return 'failed'
  return 'idle'
}

/** 会话固定标题：优先展示名/标题，缺省回落动作文案，保证 toast title 非空。 */
export function sessionTitle(title: string | undefined, label: string): string {
  const normalized = (title ?? '').trim()
  return normalized || label
}

/** 由归约 phase 推导到 pet 动作（供 push 使用，与 phaseToActivity 对齐）。 */
export function phaseActivity(record: SessionStatusRecord): PetSessionActivity {
  return phaseToActivity(record.phase)
}

/**
 * 把一条归约记录转成实时描述文案；`text` 由调用方提供（便于单测），
 * 映射表逐点对齐 dsh-dafeiyu 各阶段 → 文案。
 */
export function describeSession(
  record: SessionStatusRecord,
  text: (key: string, params?: Record<string, string>) => string,
): string {
  switch (record.phase) {
    case 'preparing':
      return text('activityPreparing')
    case 'thinking':
      return text('activityThinking')
    case 'result':
      return text('activityResult')
    case 'working':
      return record.toolName
        ? `${text('activityWorking')} · ${text('toolPrefix')} ${record.toolName}`
        : text('activityWorking')
    case 'waiting':
      return describePending(record.pendingKind, text)
    case 'review':
      return text('activityReview')
    case 'failed':
      return text('activityFailed')
    case 'stopped':
      return text('activityStopped')
    case 'idle':
    default:
      return text('activityIdle')
  }
}

/** 等待决策的类型 → 描述（对齐 dsh-dafeiyu 的 approval / user-question 与 uiSession 的 kind）。 */
export function describePending(
  pendingKind: string | undefined,
  text: (key: string, params?: Record<string, string>) => string,
): string {
  switch (pendingKind) {
    case 'approval':
      return text('activityApproval')
    case 'plan-review':
      return text('pendingPlanReview')
    case 'question':
      return text('pendingQuestion')
    case 'user-question':
      return text('activityWaiting')
    default:
      return text('activityWaiting')
  }
}

export function activityBubble(activity: PetSessionActivity, label: string, title?: string): string | undefined {
  if (activity === 'idle')
    return undefined
  const message = title ? `${label}: ${title}` : label
  return Array.from(message).slice(0, PET_ACTIVITY_BUBBLE_MAX).join('')
}
