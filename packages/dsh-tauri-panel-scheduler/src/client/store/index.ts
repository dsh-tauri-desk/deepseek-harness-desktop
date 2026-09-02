/**
 * store/index.ts — 调度器共享客户端状态（任务列表 + 执行记录 + 对话框选项）。
 *
 * 模块级 SnapshotStore 供面板各子组件订阅；所有后端调用集中在 apis/client.ts。
 * 轮询刷新由组件生命周期驱动（useSyncExternalStore + setInterval），见
 * components/scheduler-panel.tsx。
 */

import type { RunView, SchedulerOptions, TaskView } from '../types'
import { createExternalStore } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { createSchedulerInjected } from '../apis'

/** 领域 injected（模块级单例，与面板注册共享）。 */
export const schedulerApi = createSchedulerInjected()

/** 面板 UI 状态。 */
export interface SchedulerUiState {
  tasks: TaskView[]
  runs: RunView[]
  options: SchedulerOptions
  loading: boolean
  error: string
  refreshedAt: number
}

/** 初始状态。 */
export function blankUiState(): SchedulerUiState {
  return {
    tasks: [],
    runs: [],
    options: { workspaces: [], permissions: [], defaultPermission: 'read-only', models: [], defaultModel: null },
    loading: false,
    error: '',
    refreshedAt: 0,
  }
}

export const schedulerStore = createExternalStore<SchedulerUiState>(blankUiState())

/** 取当前状态快照。 */
export function selectSchedulerState(): SchedulerUiState {
  return schedulerStore.getSnapshot()
}

/** 组件内订阅调度器状态（uSES）。 */
export function useSchedulerState(): SchedulerUiState {
  return useSyncExternalStore(schedulerStore.subscribe, () => schedulerStore.getSnapshot())
}

/** 合并状态（merge 语义）。 */
function patchState(patch: Partial<SchedulerUiState>): void {
  schedulerStore.set(state => ({ ...state, ...patch }))
}

/** 轮询代际：只允许最新一次 refresh 落地，防止旧响应覆盖新状态。 */
let refreshGeneration = 0

/** 拉取任务 + 执行记录 + 选项（幂等，可重复调用）。 */
export async function refreshScheduler(loadOptions = false): Promise<void> {
  const generation = ++refreshGeneration
  patchState({ loading: true, error: '' })
  try {
    const [tasks, runs] = await Promise.all([
      schedulerApi.listTasks(),
      schedulerApi.listRuns(),
    ])
    if (generation !== refreshGeneration)
      return
    patchState({ tasks: tasks.tasks, runs: runs.runs, loading: false, refreshedAt: Date.now() })
    if (loadOptions) {
      const options = await schedulerApi.fetchOptions()
      if (generation !== refreshGeneration)
        return
      patchState({ options })
    }
  }
  catch (error) {
    if (generation !== refreshGeneration)
      return
    patchState({ loading: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** 新建任务（成功则刷新）。返回 { ok, error? }。 */
export async function applyCreateTask(input: Record<string, unknown>): Promise<{ ok: boolean, error?: string }> {
  const result = await schedulerApi.createTask(input)
  if (!result.ok)
    return { ok: false, error: result.error }
  await refreshScheduler()
  return { ok: true }
}

/** 更新任务。 */
export async function applyUpdateTask(id: string, input: Record<string, unknown>): Promise<{ ok: boolean, error?: string }> {
  const result = await schedulerApi.updateTask(id, input)
  if (!result.ok)
    return { ok: false, error: result.error }
  await refreshScheduler()
  return { ok: true }
}

/** 暂停/恢复。 */
export async function applyToggleTask(id: string, enabled: boolean): Promise<{ ok: boolean, error?: string }> {
  const result = await schedulerApi.toggleTask(id, enabled)
  if (!result.ok)
    return { ok: false, error: result.error }
  await refreshScheduler()
  return { ok: true }
}

/** 删除任务。 */
export async function applyDeleteTask(id: string): Promise<{ ok: boolean, error?: string }> {
  const result = await schedulerApi.deleteTask(id)
  if (!result.ok)
    return { ok: false, error: result.error }
  await refreshScheduler()
  return { ok: true }
}

/** 立即运行。 */
export async function applyDeleteRun(id: string): Promise<{ ok: boolean, error?: string }> {
  const result = await schedulerApi.deleteRun(id)
  if (!result.ok)
    return result
  await refreshScheduler()
  return { ok: true }
}

export async function applyClearRuns(): Promise<{ ok: boolean, error?: string }> {
  const result = await schedulerApi.clearRuns()
  if (!result.ok)
    return result
  await refreshScheduler()
  return { ok: true }
}

export async function applyRunTask(id: string): Promise<{ ok: boolean, error?: string }> {
  const result = await schedulerApi.runTask(id)
  if (!result.ok)
    return { ok: false, error: result.error }
  await refreshScheduler()
  return { ok: true }
}

/** 启动自愈（应用启动时调用一次）。 */
export function hydrateScheduler(): void {
  void schedulerApi.recover().then(() => refreshScheduler(true)).catch(() => {})
}
