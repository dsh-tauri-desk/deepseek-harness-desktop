export interface InputActions {
  setDraft: (text: string) => void
}

export interface ConversationInputLeftProps {
  sessionId: string
  inputActions: InputActions
}
