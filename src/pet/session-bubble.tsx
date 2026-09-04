import { useSyncExternalStore } from 'react'
import { sessionBubbleStore } from './session-bubbles'

/**
 * 会话 Toast 实时描述宿主：作为 toast 的 description 元素在 add 时传入一次，
 * 通过订阅 store 的版本号在描述变化时原地重渲染，保持实例稳定；
 * 标题由调用方以固定字符串写入 content.title，不随状态变化。
 */
export function SessionBubble({ sessionId }: { sessionId: string }) {
  const version = useSyncExternalStore(
    sessionBubbleStore.subscribe,
    sessionBubbleStore.getSnapshot,
  )
  void version
  return sessionBubbleStore.get(sessionId) ?? ''
}
