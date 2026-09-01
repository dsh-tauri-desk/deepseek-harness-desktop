/**
 * components/skill-creator-prefill.tsx — 新会话草稿预填组件。
 *
 * 注册进 conversation.input.left；当 createSkill 流程登记了该会话 id 时，
 * 挂载后把技能创建器草稿写进输入框，随后从登记集合移除（一次性）。
 */

import type { ConversationInputLeftProps } from '../types'
import { useEffect } from 'react'
import { pendingPrefills } from '../config'
import { SKILL_CREATOR_DRAFT } from '../constants'

export function SkillCreatorPrefill({ sessionId, inputActions }: ConversationInputLeftProps): null {
  useEffect(() => {
    if (!pendingPrefills.delete(sessionId))
      return
    inputActions.setDraft(SKILL_CREATOR_DRAFT)
  }, [inputActions, sessionId])
  return null
}
