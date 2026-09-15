import type { TaskInput } from '../types'
import {
  getHistory,
  getOptions,
  getTasks,
  postHistoryDelete,
  postRecover,
  postTasksCreate,
  postTasksDelete,
  postTasksRun,
  postTasksToggle,
  postTasksUpdate,
} from '../apis'
import { store } from '../store'

export async function loadScheduler(withOptions = false): Promise<void> {
  const token = store.scheduler.loadToken + 1
  store.scheduler.$patch({ loadToken: token, loading: true, error: '' })
  try {
    const [tasks, runs] = await Promise.all([getTasks(), getHistory()])
    if (token !== store.scheduler.loadToken)
      return
    store.scheduler.$patch({ tasks: tasks.tasks, runs: runs.runs, loading: false, refreshedAt: Date.now() })
    if (!withOptions)
      return
    const options = await getOptions()
    if (token !== store.scheduler.loadToken)
      return
    store.scheduler.$patch({ options })
  }
  catch (error) {
    if (token !== store.scheduler.loadToken)
      return
    store.scheduler.$patch({ loading: false, error: messageOf(error) })
  }
}

export async function recoverScheduler(): Promise<{ ok: boolean, error?: string }> {
  try {
    await postRecover()
  }
  catch (error) {
    return { ok: false, error: messageOf(error) }
  }
  await loadScheduler(true)
  return { ok: true }
}

export async function createTask(input: TaskInput): Promise<{ ok: boolean, error?: string }> {
  const result = await postTasksCreate(input)
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

export async function updateTask(id: string, input: TaskInput): Promise<{ ok: boolean, error?: string }> {
  const result = await postTasksUpdate({ id, input })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

export async function toggleTask(id: string, enabled: boolean): Promise<{ ok: boolean, error?: string }> {
  const result = await postTasksToggle({ id, enabled })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

export async function deleteTask(id: string): Promise<{ ok: boolean, error?: string }> {
  const result = await postTasksDelete({ id })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

export async function runTask(id: string): Promise<{ ok: boolean, error?: string }> {
  const result = await postTasksRun({ id })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

export async function deleteRun(id: string): Promise<{ ok: boolean, error?: string }> {
  const result = await postHistoryDelete({ id })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

// --- internal ---

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
