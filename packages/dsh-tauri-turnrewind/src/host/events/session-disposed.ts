import { capture } from '../service/capture'

/** 会话结束（关闭/删除/应用退出）：整个会话的运行中读数归零，提示条不会带着上一轮的统计留到下次打开。 */
export function handleSessionDisposed(session: any): void {
  const sessionId = typeof session?.id === 'string' && session.id.length > 0 ? session.id : session?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0)
    return
  capture.resetLive(sessionId)
}
