import type { TurnrewindSessionState } from './session.types'

/**
 * 无缓存会话的空白态。
 *
 * 引用必须稳定（模块级常量）：每次对缺席会话都返回同一个对象，订阅方才不会因为
 * 「每次读到新对象」而无休止重渲染。
 */
export const EMPTY_SESSION_STATE: TurnrewindSessionState = {
  status: 'idle',
  summary: null,
  error: null,
  awaitingTurn: null,
  undoing: false,
  undoError: null,
  undoConflicts: [],
}

/** 取某会话的状态切片（无则空白态）。对状态容器结构开放，调用方无需断言。 */
export function sessionStateOf<C extends { bySession: Record<string, unknown> }>(
  state: C,
  sessionId: string | undefined,
): TurnrewindSessionState {
  if (sessionId === undefined)
    return EMPTY_SESSION_STATE
  return (state.bySession[sessionId] as TurnrewindSessionState | undefined) ?? EMPTY_SESSION_STATE
}
