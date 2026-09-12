/**
 * service/actions.ts — 工作树变更动作（检出 / 放弃），含 job 轮询与乐观状态。
 *
 * 错误归一由 dsh-tauri 的 JSON 客户端统一承担，apis/ 直接返回解析后的类型；
 * 本文件只做去重（discardInFlight）、生命周期控制器与 store 的乐观 patch。
 */
import type { WorktreeBindings, WorktreeCheckout, WorktreeCreate, WorktreeDiscard, WorktreeStatus } from '../types'
import { createLifecycleController } from 'dsh-tauri/client'
import { getBindings, getStatus, postAttach, postCheckout, postCreate, postDiscard } from '../apis'
import { DISCARD_MAX_POLLS, DISCARD_POLL_DELAY_MS } from '../constants'
import { patchSession } from '../store'

/** 从 unknown 错误里取可展示文本。 */
function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 批量查询工作树绑定（解析后的领域函数）——hydration 用一次请求替代逐会话 /status。 */
export function fetchBindings(): Promise<WorktreeBindings> {
  return getBindings()
}

/** 查询某会话的工作树状态（解析后的领域函数）。 */
export function fetchStatus(sessionId: string, jobId?: string): Promise<WorktreeStatus> {
  return getStatus({ sessionId, jobId })
}

/** 为预分配的新会话创建工作树（解析后的领域函数）。 */
export function createWorktree(sessionId: string, sourceSessionId = sessionId, inherit = false): Promise<WorktreeCreate> {
  return postCreate({ sessionId, sourceSessionId, inherit })
}

/** 将已创建的 worktree 会话正式归属到源项目 Workspace（解析后的领域函数）。 */
export function attachWorktreeSession(sessionId: string): Promise<{ ok: boolean, workspaceId: string }> {
  return postAttach({ sessionId })
}

/** 放弃更改：删除工作树并解除绑定，会话保留（解析后的领域函数）。 */
export function discardWorktree(sessionId: string, worktreeHashDirname: string): Promise<WorktreeDiscard> {
  return postDiscard({ sessionId, worktreeHashDirname })
}

/** 检出本地（弹窗确认后调用）。 */
export async function applyCheckout(
  sessionId: string,
  worktreeHashDirname: string,
  branchName: string,
): Promise<{ ok: boolean, error?: string, targetSessionId?: string }> {
  try {
    const result: WorktreeCheckout = await postCheckout({ sessionId, worktreeHashDirname, branchName })
    patchSession(sessionId, {
      mode: 'local',
      phase: 'idle',
      loadingLabel: '',
      log: [],
      worktreeKey: '',
      checkoutOpen: false,
      error: '',
    })
    return { ok: true, targetSessionId: result.targetSessionId }
  }
  catch (error) {
    patchSession(sessionId, { error: errMessage(error) })
    return { ok: false, error: errMessage(error) }
  }
}

/** Reconcile the optimistic state after a Host discard job settles. */
async function pollDiscardJob(
  sessionId: string,
  jobId: string,
  controller: ReturnType<typeof createLifecycleController>,
): Promise<{ ok: boolean, error?: string }> {
  let lastError = ''
  for (let attempt = 0; attempt < DISCARD_MAX_POLLS; attempt++) {
    if (controller.isDisposed())
      return { ok: false, error: 'Discard operation was cancelled.' }

    const status = await new Promise<WorktreeStatus | undefined>((resolve, reject) => {
      controller.timeout(() => {
        fetchStatus(sessionId, jobId).then(resolve).catch(reject)
      }, DISCARD_POLL_DELAY_MS)
    }).catch((error: unknown) => {
      lastError = errMessage(error)
      return undefined
    })
    if (!status)
      continue
    if (status.mode === 'deleting')
      continue
    if (status.mode === 'failed') {
      const error = status.error ?? 'Failed to delete worktree.'
      patchSession(sessionId, { phase: 'error', error })
      return { ok: false, error }
    }
    if (status.mode !== 'local') {
      const error = 'Worktree deletion did not complete.'
      patchSession(sessionId, { phase: 'error', error })
      return { ok: false, error }
    }
    patchSession(sessionId, {
      mode: 'local',
      phase: 'idle',
      loadingLabel: '',
      log: [],
      worktreeKey: '',
      worktreePath: '',
      abandonOpen: false,
      error: '',
    })
    return { ok: true }
  }
  const error = lastError || 'Timed out waiting for worktree deletion.'
  patchSession(sessionId, { phase: 'error', error })
  return { ok: false, error }
}

const discardInFlight = new Map<string, Promise<{ ok: boolean, error?: string }>>()

/** 放弃更改：立即乐观标记删除，并在后台轮询 Host job。 */
export async function applyDiscard(
  sessionId: string,
  worktreeHashDirname: string,
): Promise<{ ok: boolean, error?: string }> {
  const key = `${sessionId}:${worktreeHashDirname}`
  const existing = discardInFlight.get(key)
  if (existing)
    return existing

  const controller = createLifecycleController()
  const operation = (async (): Promise<{ ok: boolean, error?: string }> => {
    patchSession(sessionId, { phase: 'deleting', abandonOpen: false, error: '' })
    try {
      const result = await discardWorktree(sessionId, worktreeHashDirname)
      if (!result.ok) {
        const error = result.error ?? 'Failed to start worktree deletion.'
        patchSession(sessionId, { phase: 'error', error })
        controller.dispose()
        discardInFlight.delete(key)
        return { ok: false, error }
      }
      if (!result.jobId) {
        patchSession(sessionId, {
          mode: 'local',
          phase: 'idle',
          loadingLabel: '',
          log: [],
          worktreeKey: '',
          worktreePath: '',
          error: '',
        })
        controller.dispose()
        discardInFlight.delete(key)
        return { ok: true }
      }

      // Resolve the UI action as soon as the job is accepted. Keep the in-flight
      // entry until polling settles so repeated clicks cannot enqueue another job.
      void pollDiscardJob(sessionId, result.jobId, controller).finally(() => {
        controller.dispose()
        discardInFlight.delete(key)
      })
      return { ok: true }
    }
    catch (error) {
      const message = errMessage(error)
      patchSession(sessionId, { phase: 'error', error: message })
      controller.dispose()
      discardInFlight.delete(key)
      return { ok: false, error: message }
    }
  })()
  discardInFlight.set(key, operation)
  return operation
}
