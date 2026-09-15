import type { ConversationInputLeftProps } from './skill-creator-prefill.types'
import { useEffect } from 'react'
import { SKILL_CREATOR_DRAFT } from '../constants'
import { store } from '../store'

export function SkillCreatorPrefill({ sessionId, inputActions }: ConversationInputLeftProps): null {
  useEffect(() => {
    if (!store.prefill.consume(sessionId))
      return
    inputActions.setDraft(SKILL_CREATOR_DRAFT)
  }, [inputActions, sessionId])
  return null
}
