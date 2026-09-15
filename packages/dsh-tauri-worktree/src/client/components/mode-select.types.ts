import type { InputActions, InputState, SessionsRuntime, WorkspacesRuntime } from '../service/session-switch.types'

export interface ModeSelectProps {
  sessionId: string
  useInput: <S>(selector: (state: InputState) => S) => S
  inputActions: InputActions
  sessionsRuntime: SessionsRuntime
  workspacesRuntime: WorkspacesRuntime
}
