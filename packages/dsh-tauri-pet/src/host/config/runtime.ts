import type { HostContext } from 'dsh-tauri'
import type { SessionStreamSink } from '../types'
import { defineHostRuntime } from 'dsh-tauri'

export const { setCurrentHostInstance, getCurrentHostInstance } = defineHostRuntime<HostContext>()

/** 已接入的 SSE 消费者（断连即移除）。 */
export const sinks = new Set<SessionStreamSink>()

/** 会话出生标记：首次出现的 id 推 create，此后只推增量 update。 */
export const knownSessions = new Set<string>()

/** 会话总线监听注销句柄；undefined = 当前无消费者、未挂载。 */
let disposeSessionBus: (() => void) | undefined

export function isSessionBusAttached(): boolean {
  return disposeSessionBus !== undefined
}

export function setSessionBusDispose(dispose: (() => void) | undefined): void {
  disposeSessionBus = dispose
}

/** 注销会话总线监听并丢弃会话标记（幂等）。 */
export function closeSessionBus(): void {
  const dispose = disposeSessionBus
  disposeSessionBus = undefined
  dispose?.()
  knownSessions.clear()
}

/** 插件卸载收尾：结束在途连接、注销监听、丢弃标记并解绑宿主实例。 */
export function clearHostRuntime(): void {
  const open = [...sinks]
  sinks.clear()
  closeSessionBus()
  setCurrentHostInstance(undefined)
  for (const sink of open)
    sink.close()
}
