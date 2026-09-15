import type * as Types from './index.type'
import { fetch } from 'dsh-tauri/client'
import { API_PREFIX } from '../constants'

const baseURL = API_PREFIX

export function getTasks(query?: Types.GetTasksQuery): Promise<Types.TasksResponse> {
  return fetch(`${baseURL}/tasks${query?.search ? `?search=${encodeURIComponent(query.search)}` : ''}`)
}

export function postTasksCreate(body: Types.PostTasksCreateBody): Promise<Types.TaskActionResult> {
  return fetch(`${baseURL}/tasks/create`, { method: 'POST', body })
}

export function postTasksUpdate(body: Types.PostTasksUpdateBody): Promise<Types.TaskActionResult> {
  return fetch(`${baseURL}/tasks/update`, { method: 'POST', body: { id: body.id, ...body.input } })
}

export function postTasksToggle(body: Types.PostTasksToggleBody): Promise<Types.TaskActionResult> {
  return fetch(`${baseURL}/tasks/toggle`, { method: 'POST', body })
}

export function postTasksDelete(body: Types.PostIdBody): Promise<Types.SimpleActionResult> {
  return fetch(`${baseURL}/tasks/delete`, { method: 'POST', body })
}

export function postTasksRun(body: Types.PostIdBody): Promise<Types.SimpleActionResult> {
  return fetch(`${baseURL}/tasks/run`, { method: 'POST', body })
}

export function getHistory(query?: Types.GetHistoryQuery): Promise<Types.RunsResponse> {
  return fetch(`${baseURL}/history${query?.taskId ? `?taskId=${encodeURIComponent(query.taskId)}` : ''}`)
}

export function postHistoryDelete(body: Types.PostIdBody): Promise<Types.SimpleActionResult> {
  return fetch(`${baseURL}/history/delete`, { method: 'POST', body })
}

export function getOptions(): Promise<Types.SchedulerOptions> {
  return fetch(`${baseURL}/options`)
}

export function postRecover(): Promise<unknown> {
  return fetch(`${baseURL}/recover`, { method: 'POST', body: {} })
}
