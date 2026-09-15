import { useStore } from 'dsh-tauri/client'
import { useEffect } from 'react'
import { store } from '../store'
import { applyPrefillToComposer } from './prefill-bridge.utils'

interface PrefillBridgeProps {
  inputActions?: { setDraft: (text: string) => void }
}

export function PrefillBridge({ inputActions }: PrefillBridgeProps): null {
  const { pending } = useStore(store.prefill)

  useEffect(() => {
    if (pending === '')
      return
    if (inputActions !== undefined) {
      inputActions.setDraft(pending)
      store.prefill.clear()
      return
    }
    if (applyPrefillToComposer(pending))
      store.prefill.clear()
  }, [pending, inputActions])

  return null
}
