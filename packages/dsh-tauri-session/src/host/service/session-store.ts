import type { SessionLike } from '../config/runtime.types'
import { defineService } from 'dsh-tauri'
import { compact } from 'lodash-es'
import { getCurrentHostInstance } from '../config/runtime'

export const sessionStore = defineService({
  /** 读宿主内存会话对象（get 缺失时回退到会话枚举）。 */
  load(sessionId: string): SessionLike | null {
    if (!sessionId)
      return null
    const sessions = getCurrentHostInstance().sessions
    return sessions.get?.(sessionId)
      ?? sessions.list?.().find(session => session.id === sessionId)
      ?? null
  },

  /**
   * 从宿主内存会话 store 移除（best-effort），返回无法移除的 id。
   * 删除所需面在触碰任何数据之前校验，缺失即抛错，保证失败可整体重试。
   */
  remove(sessionIds: readonly string[]): string[] {
    const sessions = getCurrentHostInstance().sessions
    const live = compact(sessionIds.map(sessionId => (sessions.get?.(sessionId) ? sessionId : null)))
    if (live.length > 0 && !sessions.remove)
      throw new Error('宿主未提供 SessionStore.remove，请先更新桌面壳')
    return live.filter(sessionId => !sessions.remove?.(sessionId))
  },
})
