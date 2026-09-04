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
/** 失败动画脉冲时长（毫秒）：对齐参考实现 companion-reducer 的工具失败脉冲 ttlMs=1800。
 * 失败只作为瞬态脉冲展示一次，到期自动恢复到底层会话状态，避免 DSH 快照上粘性的
 * lastAgentError 经插件 250ms 心跳重发后永久占用 'failed'、阻塞其他会话的动画切换。 */
const FAILED_PULSE_TTL = 1800

/** 桌宠窗口的会话气泡：DSH 发送原始会话快照，本 hook 私有管理会话→toast key 映射，仅暴露聚合宠物状态。 */
export function useBubble(): BubbleHandle {
  const [status, setStatus] = useState<PetStatus | undefined>(undefined)

  useEffect(() => {
    const sessions = new Map<string, BubbleSession>()
    const toastKeys = new Map<string, string>()
    const hideTimers = new Map<string, number>()
    const previousStatus = new Map<string, PetStatus | undefined>()
    /** 失败脉冲截止时间戳（参考实现 ttlMs=1800）：截止前该会话贡献 'failed'，到期后忽略其失败信号。 */
    const failedUntil = new Map<string, number>()
    const pulseTimers = new Map<string, number>()
    /** 已消费的失败会话：脉冲播完一次后记录，粘性 lastAgentError 心跳重发 / 刷新重连不再重播。 */
    const consumedFailed = new Set<string>()
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
        failedUntil.delete(session.id)
        consumedFailed.delete(session.id)
        clearPulseTimer(session.id)
        clearHideTimer(session.id)
        closeToast(session.id)
      }
      else {
        sessions.set(session.id, session)
        trackFailedPulse(session)
        syncToast(session)
      }

      if (!disposed)
        setStatus(statusOf(sessions, failedUntil, Date.now()))
    }

    /**
     * 参考实现 companion-reducer 的失败脉冲语义：工具失败以 ttlMs=1800 的 PULSE
     * 发射，动画播完失败片段后恢复到底层工作状态，而不是把记录钉死在 ERROR。
     * 这里在会话状态跃迁到 failed 的瞬间启动一次脉冲计时器；插件心跳（250ms）重发
     * 相同的失败快照不会刷新截止时间，刷新/重连后首次收到失败快照也只是重新播一次
     * 脉冲，随后立即让位给 waiting / review / running / idle。
     */
    function trackFailedPulse(session: BubbleSession): void {
      const current = sessionStatus(session)
      const previous = previousStatus.get(session.id)
      if (current === 'failed') {
        // 粘性失败快照（lastAgentError 不随心跳清除）：脉冲只在首次跃迁时播一次，
        // 心跳重发 / 刷新重连后该会话的失败信号保持已消费，直到状态真正离开 failed。
        if (previous === 'failed' || consumedFailed.has(session.id))
          return
        const deadline = Date.now() + FAILED_PULSE_TTL
        failedUntil.set(session.id, deadline)
        clearPulseTimer(session.id)
        const timer = window.setTimeout(() => {
          if (disposed)
            return
          if (failedUntil.get(session.id) !== deadline)
            return
          failedUntil.delete(session.id)
          clearPulseTimer(session.id)
          consumedFailed.add(session.id)
          setStatus(statusOf(sessions, failedUntil, Date.now()))
        }, FAILED_PULSE_TTL)
        pulseTimers.set(session.id, timer)
      }
      else {
        failedUntil.delete(session.id)
        clearPulseTimer(session.id)
        consumedFailed.delete(session.id)
      }
    }

    function clearPulseTimer(id: string): void {
      const timer = pulseTimers.get(id)
      if (timer !== undefined) {
        window.clearTimeout(timer)
        pulseTimers.delete(id)
      }
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
      for (const timer of pulseTimers.values())
        window.clearTimeout(timer)
      pulseTimers.clear()
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

/**
 * 聚合优先级对齐参考实现 companion-reducer 的 statePriority：WAITING(60) > ERROR(50)
 * > WORKING(30)/THINKING(20)。因此 waiting / review（等待用户）优先于 failed，
 * 任一会话处于等待时动画必须让位给等待状态，失败不再拥有绝对优先级。
 * failed 仅在其脉冲窗口（FAILED_PULSE_TTL）内生效，窗口过后恢复到底层状态
 * （underlyingStatus），避免粘性 lastAgentError 永久占用聚合状态。
 */
function statusOf(
  sessions: ReadonlyMap<string, BubbleSession>,
  failedUntil: ReadonlyMap<string, number>,
  now: number,
): PetStatus | undefined {
  const statuses = [...sessions.values()].map((session) => {
    const status = sessionStatus(session)
    if (status !== 'failed')
      return status
    const deadline = failedUntil.get(session.id)
    return deadline !== undefined && now < deadline ? 'failed' : underlyingStatus(session)
  })
  return statuses.find(value => value === 'waiting')
    ?? statuses.find(value => value === 'review')
    ?? statuses.find(value => value === 'failed')
    ?? statuses.find(value => value === 'running')
    ?? undefined
}

/** 忽略粘性 lastAgentError / 终态 value 后该会话的底层状态：失败脉冲结束后的恢复目标（参考实现 resumeState）。 */
function underlyingStatus(session: BubbleSession): PetStatus | undefined {
  const value = session.status ?? session.activity ?? session.phase
  if (value === 'review' || value === 'reviewing' || value === 'plan-review')
    return 'review'
  if (value === 'waiting' || value === 'pending' || value === 'blocked' || hasPendingInteraction(session.pendingInteraction) || hasPendingItems(session.pending))
    return 'waiting'
  if (value === 'running' || value === 'working' || value === 'thinking' || session.running === true)
    return 'running'
  return undefined
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
