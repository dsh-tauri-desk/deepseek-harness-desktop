/**
 * utils/throttle.ts — 按 key 的前沿 + 拖尾节流（无 React / 无 DOM / 不直接持有全局定时器）。
 *
 * 为什么需要：hydrate 的状态复核由「会话事件流」和「会话列表快照」双路触发，二者在
 * 流式输出期间每秒可通知上百次。逐次复核会把只读的 GET /status 放大成持续请求风暴
 * （宿主还会为每次请求 fork 一个 git 子进程）。本模块把同一 key 的执行频率压到
 * 「每 intervalMs 至多一次」：窗口内的首个请求立即执行（前沿），窗口内的后续请求
 * 合并为窗口末尾的一次拖尾执行（最后一次不丢失，也不需要退避重排定时器）。
 *
 * 时间源与调度器由调用方注入：生产走 createLifecycleController().timeout（卸载自动
 * 清理），单测注入假时钟即可在 node 环境确定性地断言节流行为。
 */

export interface KeyedThrottleOptions {
  /** 同一 key 两次执行之间的最小间隔（毫秒）。 */
  intervalMs: number
  /** 当前时间源（默认 Date.now；单测注入假时钟）。 */
  now?: () => number
  /** 延迟调度器，返回提前取消句柄（默认 setTimeout；生产注入 controller.timeout）。 */
  schedule?: (fn: () => void, ms: number) => () => void
}

export interface KeyedThrottle {
  /** 请求执行：首次立即执行，窗口内合并为一次拖尾执行。 */
  request: (key: string, run: () => void) => void
  /** 取消某 key 待执行的拖尾任务并清空其节流窗口。 */
  cancel: (key: string) => void
  /** 清空全部 key（插件卸载时调用）。 */
  clear: () => void
}

interface KeyEntry {
  lastRunAt: number
  cancelTimer: () => void
  pending: (() => void) | null
}

/** 创建按 key 的节流器。 */
export function createKeyedThrottle(options: KeyedThrottleOptions): KeyedThrottle {
  const intervalMs = Math.max(0, options.intervalMs)
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  })
  const entries = new Map<string, KeyEntry>()

  return {
    request(key, run) {
      const entry = entries.get(key)
      if (!entry) {
        // 先登记再执行：run 同步重入同一 key 时进入节流分支，不会无限递归立即执行。
        entries.set(key, { lastRunAt: now(), cancelTimer: () => {}, pending: null })
        run()
        return
      }
      // 已排定拖尾执行：只替换回调（同窗口合并为一次），不堆叠第二次执行。
      if (entry.pending) {
        entry.pending = run
        return
      }
      const delay = intervalMs - (now() - entry.lastRunAt)
      if (delay <= 0) {
        entry.lastRunAt = now()
        run()
        return
      }
      entry.pending = run
      entry.cancelTimer = schedule(() => {
        const pending = entry.pending
        entry.pending = null
        entry.cancelTimer = () => {}
        if (!pending)
          return
        entry.lastRunAt = now()
        pending()
      }, delay)
    },
    cancel(key) {
      const entry = entries.get(key)
      if (!entry)
        return
      entry.cancelTimer()
      entries.delete(key)
    },
    clear() {
      for (const entry of entries.values())
        entry.cancelTimer()
      entries.clear()
    },
  }
}
