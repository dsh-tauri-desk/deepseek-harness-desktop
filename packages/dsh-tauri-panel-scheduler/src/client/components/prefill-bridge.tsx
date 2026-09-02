/**
 * components/prefill-bridge.tsx — 「通过 Chat 创建」草稿预填桥（照搬 dsh-automation
 * index.ts 的 PrefillBridge）：挂载时应用一次 peekChatPrefill，并订阅后续
 * setChatPrefill；优先走 inputActions.setDraft，缺失时回退 applyPrefillToDom。
 */

import { useEffect } from 'react'
import { applyPrefillToDom, peekChatPrefill, subscribeChatPrefill, takeChatPrefill } from '../prefill'

export interface PrefillBridgeProps {
  inputActions?: { setDraft: (text: string) => void }
}

export function PrefillBridge(props: PrefillBridgeProps): null {
  useEffect(() => {
    const applyPrefill = (text: string | null): void => {
      if (text === null || text === '')
        return
      if (props.inputActions !== undefined) {
        props.inputActions.setDraft(text)
        takeChatPrefill()
        return
      }
      if (applyPrefillToDom(text))
        takeChatPrefill()
    }
    applyPrefill(peekChatPrefill())
    return subscribeChatPrefill(applyPrefill)
  }, [props.inputActions])
  return null
}
