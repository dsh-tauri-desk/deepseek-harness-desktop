/**
 * apis/client.ts — 调度器 API 客户端（ofetch 统一封装）与领域 injected 装配。
 *
 * 与宿主侧 host/routes/ 的路由一一对应；所有视图类型集中在本插件 client/types/。
 * 装配产物（SchedulerInjected）由 index.ts 注入到组件树。
 */

import type { RunView, SchedulerInjected, SchedulerOptions, TaskView } from '../types'
import { createJsonClient } from 'dsh-tauri/client'
import { API_PREFIX } from '../constants'

/** ofetch 统一 JSON 客户端（错误信息优先取宿主 error 字段）。 */
const jsonApi = createJsonClient(API_PREFIX, {
  errorMessage: (status, body) => {
    const error = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : ''
    return error || `HTTP ${status}`
  },
})

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return jsonApi.request<T>(path, init)
}

function post<T>(path: string, body: unknown): Promise<T> {
  return jsonApi.post<T>(path, body)
}

export function createSchedulerInjected(): SchedulerInjected {
  return {
    listTasks: search => fetchJson<{ tasks: TaskView[] }>(`/tasks${search ? `?search=${encodeURIComponent(search)}` : ''}`),
    createTask: input => post('/tasks/create', input),
    updateTask: (id, input) => post('/tasks/update', { id, ...input }),
    toggleTask: (id, enabled) => post('/tasks/toggle', { id, enabled }),
    deleteTask: id => post('/tasks/delete', { id }),
    runTask: id => post('/tasks/run', { id }),
    listRuns: taskId => fetchJson<{ runs: RunView[] }>(`/history${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`),
    deleteRun: id => post('/history/delete', { id }),
    clearRuns: () => post('/history/clear', {}),
    fetchOptions: () => fetchJson<SchedulerOptions>('/options'),
    recover: async () => { await post('/recover', {}) },
  }
}
