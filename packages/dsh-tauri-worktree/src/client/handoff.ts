import type { WorktreeHydrationSessionsRuntime } from './types'
import { SESSION_SWITCH_MAX_ATTEMPTS, SESSION_SWITCH_RETRY_DELAY_MS } from './constants'

interface OpenWorktreeSessionOptions {
  isActive?: () => boolean
  maxAttempts?: number
  retryDelayMs?: number
}

/**
 * 等待新工作树会话在客户端列表中稳定后再打开，并确认 selection 已实际切换。
 * Host 发布新会话、列表增量和 Session scope 可寻址并非同一时刻；只调用一次 open()
 * 会把瞬时失败永久记为已切换，最终停在空白会话页，刷新后才由持久化状态恢复。
 */
export async function openWorktreeSession(
  sessions: WorktreeHydrationSessionsRuntime,
  sourceSessionId: string,
  targetSessionId: string,
  options: OpenWorktreeSessionOptions = {},
): Promise<boolean> {
  const isActive = options.isActive ?? (() => true)
  const maxAttempts = options.maxAttempts ?? SESSION_SWITCH_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? SESSION_SWITCH_RETRY_DELAY_MS
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!isActive())
      return false
    let snapshot = sessions.list.getSnapshot()
    if (snapshot.current === targetSessionId)
      return true

    // 用户已主动切到其他会话时不能再抢回；pending 阶段 current 暂时为空则继续等待。
    if (snapshot.current !== sourceSessionId && !(snapshot.current === undefined && snapshot.phase === 'pending'))
      return false

    if (!snapshot.ids.includes(targetSessionId)) {
      await sessions.refresh().catch(() => {})
      if (!isActive())
        return false
      snapshot = sessions.list.getSnapshot()
      if (snapshot.current === targetSessionId)
        return true
      if (snapshot.current !== sourceSessionId && !(snapshot.current === undefined && snapshot.phase === 'pending'))
        return false
    }
    if (snapshot.ids.includes(targetSessionId)) {
      try {
        sessions.open(targetSessionId)
      }
      catch {
        await sessions.refresh().catch(() => {})
      }
      if (sessions.list.getSnapshot().current === targetSessionId)
        return true
    }

    if (attempt + 1 < maxAttempts)
      await new Promise(resolve => setTimeout(resolve, retryDelayMs))
  }
  return false
}
