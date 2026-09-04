import type { PetStatus } from './use-pet'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import { toast } from '@/utils/toast'

export interface BubbleSession {
  [key: string]: unknown
  id: string
}

export interface BubbleHandle {
  readonly status: PetStatus | undefined
}

type SessionAction = 'create' | 'remove' | 'update'

/** 气泡标题 / 正文的最大字符数，超长截断省略，避免失败堆栈等长文本撑爆窗口。 */
const TITLE_MAX_LENGTH = 40
const DESCRIPTION_MAX_LENGTH = 120
/** 终态气泡自动隐藏时长（毫秒）：失败展示 4s、待审阅 2.5s（对齐参考实现的完成脉冲）。实时状态（running / waiting）常驻，由后续会话事件更新内容。 */
const FAILED_BUBBLE_TIMEOUT = 4000
const REVIEW_BUBBLE_TIMEOUT = 2500

/** 桌宠窗口的会话气泡：DSH 发送原始会话快照，本 hook 私有管理会话→toast key 映射，仅暴露聚合宠物状态。 */
export function useBubble(): BubbleHandle {
  const [status, setStatus] = useState<PetStatus | undefined>(undefined)

  useEffect(() => {
    const sessions = new Map<string, BubbleSession>()
    const toastKeys = new Map<string, string>()
    const hideTimers = new Map<string, number>()
    const previousStatus = new Map<string, PetStatus | undefined>()
    /** 已自动隐藏的终态会话：保持隐藏直到状态离开终态，避免插件心跳重发 update 反复重建气泡。 */
    const dismissed = new Set<string>()
    let disposed = false

    function apply(payload: unknown, action: SessionAction): void {
      const session = rawSession(payload)
      if (session === undefined)
        return

      if (action === 'remove') {
        sessions.delete(session.id)
        previousStatus.delete(session.id)
        dismissed.delete(session.id)
        clearHideTimer(session.id)
        closeToast(session.id)
      }
      else {
        sessions.set(session.id, session)
        syncToast(session)
      }

      if (!disposed)
        setStatus(statusOf(sessions))
    }

    function syncToast(session: BubbleSession): void {
      const current = sessionStatus(session)
      const previous = previousStatus.get(session.id)
      previousStatus.set(session.id, current)
      const key = toastKeys.get(session.id)
      if (current === undefined) {
        if (key !== undefined)
          closeToast(session.id)
        return
      }

      const terminal = isTerminalStatus(current)
      // 状态离开终态后允许重建气泡。
      if (!terminal)
        dismissed.delete(session.id)

      const content = toastContent(session)
      if (key === undefined) {
        if (dismissed.has(session.id))
          return
        let createdKey = ''
        createdKey = toast(content.title, {
          description: content.description,
          placement: 'top end',
          variant: content.variant,
          timeout: 0,
          onClose: () => {
            if (toastKeys.get(session.id) === createdKey) {
              toastKeys.delete(session.id)
              clearHideTimer(session.id)
            }
          },
        })
        toastKeys.set(session.id, createdKey)
      }
      else {
        toast.update(key, content)
      }
      // 只在状态跃迁到终态时启动隐藏计时，心跳更新重置场景下不会反复延后。
      if (previous !== current && terminal)
        scheduleHide(session.id, current)
    }

    function scheduleHide(id: string, current: PetStatus): void {
      clearHideTimer(id)
      const timeout = current === 'failed'
        ? FAILED_BUBBLE_TIMEOUT
        : current === 'review'
          ? REVIEW_BUBBLE_TIMEOUT
          : undefined
      const key = toastKeys.get(id)
      if (timeout === undefined || key === undefined)
        return
      const timer = window.setTimeout(() => {
        if (toastKeys.get(id) !== key)
          return
        dismissed.add(id)
        closeToast(id)
      }, timeout)
      hideTimers.set(id, timer)
    }

    function clearHideTimer(id: string): void {
      const timer = hideTimers.get(id)
      if (timer !== undefined) {
        window.clearTimeout(timer)
        hideTimers.delete(id)
      }
    }

    function closeToast(id: string): void {
      clearHideTimer(id)
      const key = toastKeys.get(id)
      if (key === undefined)
        return
      toast.close(key)
      toastKeys.delete(id)
    }

    let unlisteners: Array<() => void> = []
    void Promise.all([
      listen('session:create', event => apply(event.payload, 'create')),
      listen('session:update', event => apply(event.payload, 'update')),
      listen('session:remove', event => apply(event.payload, 'remove')),
    ]).then((listeners) => {
      if (disposed) {
        for (const unlisten of listeners)
          unlisten()
      }
      else {
        unlisteners = listeners
      }
    }).catch(() => {})

    return () => {
      disposed = true
      for (const unlisten of unlisteners)
        unlisten()
      for (const timer of hideTimers.values())
        window.clearTimeout(timer)
      hideTimers.clear()
      for (const key of toastKeys.values())
        toast.close(key)
      toastKeys.clear()
    }
  }, [])

  return { status }
}

function rawSession(payload: unknown): BubbleSession | undefined {
  if (!payload || typeof payload !== 'object')
    return undefined
  const value = payload as Record<string, unknown>
  const session = value.session && typeof value.session === 'object'
    ? value.session as Record<string, unknown>
    : value
  const id = session.id ?? session.sessionId
  if (typeof id !== 'string' || id.length === 0)
    return undefined
  return { ...session, id }
}

function toastContent(session: BubbleSession): {
  title: string
  description: string
  variant: 'accent' | 'danger' | 'default'
} {
  const status = sessionStatus(session)
  const title = truncate(firstText(session.title, session.displayTitle, session.name, session.id), TITLE_MAX_LENGTH)
  const description = truncate(firstText(
    session.description,
    session.message,
    session.lastAgentError ? `失败：${String(session.lastAgentError)}` : undefined,
    statusLabel(status),
  ), DESCRIPTION_MAX_LENGTH)
  return {
    title,
    description,
    variant: status === 'failed' ? 'danger' : 'default',
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength)
    return text
  return `${text.slice(0, maxLength).trimEnd()}…`
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0)
      return value.trim()
  }
  return '会话'
}

function statusLabel(status: PetStatus | undefined): string {
  switch (status) {
    case 'failed': return '失败'
    case 'review': return '待审阅'
    case 'waiting': return '等待中'
    case 'running': return '思考中'
    default: return '空闲'
  }
}

function statusOf(sessions: ReadonlyMap<string, BubbleSession>): PetStatus | undefined {
  const statuses = [...sessions.values()].map(sessionStatus)
  return statuses.find(value => value === 'failed')
    ?? statuses.find(value => value === 'waiting')
    ?? statuses.find(value => value === 'review')
    ?? statuses.find(value => value === 'running')
    ?? undefined
}

function isTerminalStatus(status: PetStatus): boolean {
  return status === 'failed' || status === 'review'
}

function hasPendingInteraction(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false
}

function hasPendingItems(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null
}

function sessionStatus(session: BubbleSession): PetStatus | undefined {
  const value = session.status ?? session.activity ?? session.phase
  if (value === 'failed' || value === 'error' || session.lastAgentError)
    return 'failed'
  if (value === 'review' || value === 'reviewing' || value === 'plan-review')
    return 'review'
  if (value === 'waiting' || value === 'pending' || value === 'blocked' || hasPendingInteraction(session.pendingInteraction) || hasPendingItems(session.pending))
    return 'waiting'
  if (value === 'running' || value === 'working' || value === 'thinking' || session.running === true)
    return 'running'
  return undefined
}
