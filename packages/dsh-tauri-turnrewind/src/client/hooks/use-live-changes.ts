import type { LiveSnapshot } from '../types'
import { useEffect, useRef, useState } from 'react'
import { getLive } from '../apis'
import { TURNREWIND_LIVE_POLL_INTERVAL_MS } from '../constants'

/**
 * 一次读数属于哪个会话的哪次订阅。
 *
 * `generation` 是「订阅世代」：会话 id、或「是否在跑」的闸门一变就作废。
 * 单靠会话 id 不够——同一个会话结束（闸门关）再重新开始（闸门开）后 id 没变，
 * 上一次会话/上一轮的读数会被当成当前读数继续用（统计越叠越大）。
 */
interface LiveReading {
  sessionId: string
  generation: number
  live: LiveSnapshot
}

/**
 * 运行中实时读数（`client/hooks/`）。
 *
 * 宿主侧自己按 1.5s 刷新 git 读数、路由只读内存，所以客户端这里的轮询成本极低；
 * 反过来宿主无法主动推给客户端（不引入投影/事件轴的复杂度），故用固定间隔轮询。
 * 卸载时立刻停表；`shouldPoll` 为 false 时（会话明确未在运行）连轮询都不开。
 *
 * **读数必须随边界归零**：它只是「这一轮此刻改了什么」。会话切换、会话结束
 * （闸门关闭）、或同一个会话里闸门重新打开，旧读数一律不再成立——否则组件实例
 * 被复用时提示条会继续渲染上一份统计，并随工作区漂移越变越大（用户反馈的
 * 「统计一直在叠加」）。归零走**派生**而不是 effect 里的 setState：渲染期立刻生效，
 * 不产生额外一轮渲染，也不会在卸载路径上写状态。
 *
 * @param sessionId - 当前会话 id。
 * @param shouldPoll - 是否允许轮询（owner 份额明确说「没在跑」时置 false）。
 * @returns 最新读数；无活动 turn（或读数已过期）时为 null。
 */
export function useLiveChanges(sessionId: string | undefined, shouldPoll: boolean): LiveSnapshot | null {
  const [reading, setReading] = useState<LiveReading | null>(null)
  /** 订阅世代：每次「会话 id / 闸门」变化自增，用来让此前那份读数失效。 */
  const generationRef = useRef(0)

  useEffect(() => {
    // 每次订阅条件变化都推进世代：旧读数的 generation 随之对不上，渲染期即被丢弃。
    generationRef.current += 1
    const current = generationRef.current
    if (sessionId === undefined || !shouldPoll)
      return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        const next = await getLive(sessionId)
        // cancelled 由本次 effect 的清理函数置位：会话切换后回来的旧响应一律丢弃。
        if (!cancelled)
          setReading(next.active ? { sessionId, generation: current, live: next } : null)
      }
      catch {
        // 读数失败只影响提示条：静默清空，不打断会话。
        if (!cancelled)
          setReading(null)
      }
      if (!cancelled)
        timer = setTimeout(() => void tick(), TURNREWIND_LIVE_POLL_INTERVAL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined)
        clearTimeout(timer)
    }
  }, [sessionId, shouldPoll])

  if (!shouldPoll || reading === null || reading.sessionId !== sessionId || reading.generation !== generationRef.current)
    return null
  return reading.live
}
