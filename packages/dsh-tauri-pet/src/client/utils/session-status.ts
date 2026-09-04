/**
 * session-status.ts — 从 DSH 会话事件推导「会话进行态」的纯归约器。
 *
 * 逻辑逐点对齐 dsh-dafeiyu 的 companion-reducer.js：
 *   会话事件（turn/start、tool/call、tool/result、approval/asked、turn/end…）
 *   顺序喂入 `reduceSessionEvent`，得到当前会话的 phase（准备/思考/工具/等待/
 *   审阅/失败/空闲）+ toolName + pendingKind。只要会话在处理中，phase 不可能
 *   在两次工具调用之间回落成 idle，从而避免 Toast 闪烁（issue #308 bug 2）。
 *
 * 纯函数设计：不依赖 React / 运行时，可直接单测状态转换。每次调用返回传入
 * 记录（就地推进），seq 去重保证窗口重复回放不会重复计。
 */

import type { PetSessionActivity, PetSessionEvent } from '../types'

/** 会话进行态（驱动 toast 描述 + pet 动作），沿用 dsh-dafeiyu 的阶段粒度。 */
export type SessionPhase
  = 'preparing'
    | 'thinking'
    | 'working'
    | 'result'
    | 'waiting'
    | 'review'
    | 'failed'
    | 'stopped'
    | 'idle'

/** 归约后的一条会话状态记录。 */
export interface SessionStatusRecord {
  activity: PetSessionActivity
  phase: SessionPhase
  pendingKind?: 'approval' | 'plan-review' | 'question' | 'user-question'
  task?: string
  toolName?: string
  turnActive: boolean
  /** 尚未结束的工具调用：callId -> toolName。 */
  openTools: Map<string, string>
  /** seq 递增去重：防止同一段窗口重复回放同一事件。 */
  lastSeq: number
  updatedAt: number
}

/** 事件里取 toolCallId 的优先级；取自 dsh-dafeiyu toolCallIdOf。 */
export function toolCallIdOf(event: PetSessionEvent, fallback = ''): string {
  const message = event.data?.message as {
    content?: unknown
    source?: { callId?: unknown }
    toolCallId?: unknown
    callId?: unknown
  } | undefined
  const content = Array.isArray(message?.content)
    ? (message?.content as Array<{ toolCallId?: unknown }>).find(item => item?.toolCallId)?.toolCallId
    : undefined
  return String(
    message?.source?.callId
    ?? content
    ?? message?.toolCallId
    ?? message?.callId
    ?? event.data?.callId
    ?? fallback,
  )
}

/** 判断某个工具名是否属于「向用户提问 / 等待决策」语义；取自 dsh-dafeiyu isUserQuestionTool。 */
export function isUserQuestionTool(name: string): boolean {
  const value = String(name || '').toLowerCase()
  const tokens = value.split(/[^a-z0-9]+/u).filter(Boolean)

  const asks = new Set(['ask', 'asking', 'request', 'requests', 'requesting', 'require', 'requires', 'prompt', 'needs', 'need', 'seek', 'seeks', 'get', 'gets'])
  const filler = new Set(['for', 'from', 'the', 'a', 'an'])
  const userWords = new Set(['user', 'human', 'me'])
  const nouns = new Set(['question', 'questions', 'input', 'answer', 'answers', 'decision', 'decisions', 'confirmation', 'approval', 'permission', 'authorization', 'authorisation', 'consent', 'clarify', 'clarification', 'help'])

  const hasUserNoun = tokens.some((token, index) =>
    userWords.has(token) && nouns.has(tokens[index + 1] ?? ''),
  )
  const hasNounFromUser = tokens.some((token, index) =>
    nouns.has(token) && tokens[index + 1] === 'from' && userWords.has(tokens[index + 2] ?? ''),
  )
  const hasAsk = tokens.some((token, index) => {
    if (!asks.has(token))
      return false
    let cursor = index + 1
    while (cursor < tokens.length && (filler.has(tokens[cursor]) || userWords.has(tokens[cursor]))) {
      if (userWords.has(tokens[cursor])) {
        const next = tokens[cursor + 1]
        return !next || nouns.has(next)
      }
      cursor += 1
    }
    return cursor < tokens.length && nouns.has(tokens[cursor])
  })
  const strong = tokens.some(token =>
    token === 'authorize' || token === 'authorise' || token === 'consent',
  )
  const submitsPlanForApproval = tokens.some((token, index) =>
    token === 'exit' && tokens[index + 1] === 'plan' && tokens[index + 2] === 'mode',
  )
  return hasUserNoun || hasNounFromUser || hasAsk || strong || submitsPlanForApproval
}

/** phase → pet 动画 activity；对齐 dsh-dafeiyu 的选择与仓库既有协议。 */
export function phaseToActivity(phase: SessionPhase): PetSessionActivity {
  switch (phase) {
    case 'waiting':
      return 'waiting'
    case 'review':
      return 'review'
    case 'failed':
      return 'failed'
    case 'idle':
    case 'stopped':
      return 'idle'
    default:
      return 'running'
  }
}

/** 新建一条空闲基线记录。 */
export function createSessionStatus(): SessionStatusRecord {
  return {
    activity: 'idle',
    phase: 'idle',
    turnActive: false,
    openTools: new Map(),
    lastSeq: -1,
    updatedAt: 0,
  }
}

function nextState(state: SessionStatusRecord, patch: Partial<SessionStatusRecord>): SessionStatusRecord {
  return Object.assign(state, patch, { updatedAt: state.updatedAt + 1 }) as SessionStatusRecord
}

/**
 * 把一条会话事件归约进记录。事件可能来自 eventSource 窗口（含历史），因此
 * 先按 seq 去重：`seq <= lastSeq` 的事件视为已消费，直接跳过。
 * @returns 变更后的记录；若事件无影响或已被消费，返回原记录引用。
 */
export function reduceSessionEvent(state: SessionStatusRecord, event: PetSessionEvent): SessionStatusRecord {
  if (!event || typeof event.type !== 'string')
    return state
  const seq = Number(event.seq ?? 0)
  if (Number.isFinite(seq) && seq <= state.lastSeq)
    return state
  if (Number.isFinite(seq))
    state.lastSeq = seq

  const tools = state.openTools
  const patch: Partial<SessionStatusRecord> = {}
  const phase = state.phase

  switch (event.type) {
    case 'turn/start':
      patch.turnActive = true
      patch.task = undefined
      patch.pendingKind = undefined
      tools.clear()
      patch.activity = 'running'
      patch.phase = 'preparing'
      break

    case 'step/start':
    case 'assistant/chunk':
    case 'assistant/message':
      if (!state.turnActive || tools.size > 0)
        return state
      if (phase === 'thinking')
        return state
      patch.activity = 'running'
      patch.phase = 'thinking'
      break

    case 'tool/call': {
      const callId = toolCallIdOf(event, `seq-${String(event.seq ?? 'unknown')}`)
      const name = String(event.data?.name ?? (event.data?.message as { name?: string } | undefined)?.name ?? 'tool')
      tools.set(callId, name)
      if (isUserQuestionTool(name)) {
        patch.activity = 'waiting'
        patch.phase = 'waiting'
        patch.toolName = name
        patch.pendingKind = 'user-question'
      }
      else {
        patch.activity = 'running'
        patch.phase = 'working'
        patch.toolName = name
        patch.pendingKind = undefined
      }
      break
    }

    case 'tool/result': {
      const callId = toolCallIdOf(event)
      if (callId)
        tools.delete(callId)
      if (tools.size > 0) {
        patch.activity = 'running'
        patch.phase = 'working'
        patch.toolName = tools.values().next().value
      }
      else {
        patch.activity = 'running'
        patch.phase = 'result'
        patch.toolName = undefined
      }
      break
    }

    case 'approval/asked':
      patch.activity = 'waiting'
      patch.phase = 'waiting'
      patch.toolName = String(event.data?.toolName ?? 'approval')
      patch.pendingKind = 'approval'
      break

    case 'approval/decided':
    case 'user/message': {
      const callId = state.pendingKind === 'user-question'
        ? event.data?.callId
        : event.data?.id
      if (callId)
        tools.delete(String(callId))
      if (tools.size > 0) {
        patch.activity = 'running'
        patch.phase = 'working'
        patch.toolName = tools.values().next().value
      }
      else {
        patch.activity = 'running'
        patch.phase = 'result'
        patch.toolName = undefined
      }
      patch.pendingKind = undefined
      break
    }

    case 'todo/write': {
      const todos = Array.isArray(event.data?.todos) ? event.data.todos : []
      const current = todos.find(todo => todo?.status === 'in_progress')
        ?? todos.find(todo => todo?.status === 'pending')
      patch.task = current?.content ? String(current.content) : state.task
      break
    }

    case 'turn/end': {
      patch.turnActive = false
      tools.clear()
      patch.toolName = undefined
      const kind = String((event.data?.reason as { kind?: string } | undefined)?.kind ?? 'completed')
      if (kind === 'blocked') {
        patch.activity = 'waiting'
        patch.phase = 'waiting'
      }
      else if (kind === 'aborted') {
        patch.activity = 'idle'
        patch.phase = 'stopped'
      }
      else if (kind !== 'completed') {
        patch.activity = 'failed'
        patch.phase = 'failed'
      }
      else {
        patch.activity = 'review'
        patch.phase = 'review'
      }
      break
    }

    default:
      return state
  }

  return nextState(state, patch)
}
