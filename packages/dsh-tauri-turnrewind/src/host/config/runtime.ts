/**
 * host/config/runtime.ts — 宿主侧内存单例与宿主绑定（SSOT）。
 *
 * 进程内全部跨调用可变状态收拢在这里：工作区串行队列、资格探测缓存、账本串行队列、
 * 在途 turn 捕获状态与容量治理标记。服务层只读这些实例，不再各自持有模块级散装状态。
 */

import type { ActiveTurn, BeginningTurn } from '../service/capture.types'
import type { HostContext, WorkspaceProbe } from '../types'
import { defineHostRuntime } from 'dsh-tauri'
import { createWorkspaceQueue } from '../utils/queue'

export const { setCurrentHostInstance, getCurrentHostInstance } = defineHostRuntime<HostContext>()

/** 工作区级串行队列：私有仓 index/refs 是共享可变状态，捕获、结算、实时读数、容量治理与撤销全部串行。 */
export const workspaceQueue = createWorkspaceQueue()

/** 工作区资格探测缓存（60s TTL，stale-while-revalidate）。 */
export const probeCache = new Map<string, { at: number, result: WorkspaceProbe }>()
export const probeRefreshing = new Set<string>()

/** 会话账本的 load-modify-save 串行队列（队尾结算即出队）。 */
export const ledgerQueues = new Map<string, Promise<unknown>>()

/** 进行中的 turn 捕获状态（key = `${sessionId}:${turn}`）。 */
export const activeTurns = new Map<string, ActiveTurn>()
export const beginningTurns = new Map<string, BeginningTurn>()
export const settlingTurns = new Set<string>()

/** 已做过容量治理的工作区（每进程每个工作区只治理一次）。 */
export const retainedWorkspaces = new Set<string>()

/** 插件是否已卸载：卸载后不再登记新的捕获条目与轮询。 */
let captureDisposed = false

export function isCaptureDisposed(): boolean {
  return captureDisposed
}

export function setCaptureDisposed(disposed: boolean): void {
  captureDisposed = disposed
}

/** 插件重新装配：清空上一轮遗留的内存态并恢复运行。 */
export function resetHostRuntime(): void {
  clearState()
  captureDisposed = false
}

/** 插件卸载：清空内存态并解绑宿主实例。 */
export function clearHostRuntime(): void {
  clearState()
  captureDisposed = true
  setCurrentHostInstance(undefined)
}

function clearState(): void {
  probeCache.clear()
  probeRefreshing.clear()
  ledgerQueues.clear()
  activeTurns.clear()
  beginningTurns.clear()
  settlingTurns.clear()
  retainedWorkspaces.clear()
}
