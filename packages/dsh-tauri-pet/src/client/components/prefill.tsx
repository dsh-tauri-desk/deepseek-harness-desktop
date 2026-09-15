import type { ConversationInputLeftProps } from './prefill.types'
import { useEffect } from 'react'
import { store } from '../store'

/** 新建桌宠会话后把 /hatch 提示词一次性填入输入框（取出即消费）。 */
export function PetPrefill({ sessionId, inputActions }: ConversationInputLeftProps): null {
  useEffect(() => {
    const draft = store.pet.takePrefill(sessionId)
    if (draft === undefined)
      return
    inputActions.setDraft(draft)
  }, [inputActions, sessionId])
  return null
}
