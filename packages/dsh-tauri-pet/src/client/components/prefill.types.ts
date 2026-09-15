/** conversation.input.left 槽位注入给草稿组件的属性。 */
export interface ConversationInputLeftProps {
  inputActions: {
    setDraft: (text: string) => void
  }
  sessionId: string
}
