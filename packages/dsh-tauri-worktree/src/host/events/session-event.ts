import { get, isString } from 'lodash-es'
import { injectedCheckoutContexts, pendingHandoffs } from '../config/runtime'
import { checkoutContext } from '../service/checkout-context'
import { handoff } from '../service/handoff'

export function handleSessionEvent(session: any, event: any): void {
  if (event?.type !== 'turn/end')
    return
  const sessionId = get(session, 'id')
  if (!isString(sessionId))
    return

  const handoffPending = pendingHandoffs.get(sessionId)
  if (handoffPending) {
    pendingHandoffs.delete(sessionId)
    void handoff.complete(handoffPending)
  }

  if (injectedCheckoutContexts.delete(sessionId))
    void checkoutContext.remove(sessionId)
}
