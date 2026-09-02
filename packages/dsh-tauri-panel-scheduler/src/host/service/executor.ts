/**
 * host/service/executor.ts — 定时任务的执行器：新建独立 Agent 会话 + 注入任务指令。
 *
 * 触发模式（与 DSH 参考实现 dsh-automation / dsh-knj-scheduler 一致）：
 *   ctx.agents.create(CreateAgentOptions) → AgentHandle，随后
 *   handle.agent.followup(UserMessage) 把任务指令作为首条用户消息唤醒驱动。
 * 执行会话以 `task-<uuid>` 命名，meta.cwd 指向目标工作区（可选），并按任务记录的
 * mode/module 装载 agent preset 与模型选择；运行结束后收敛为 succeeded/failed。
 */

import type { HostContext, RunTrigger, SchedulerTask } from '../types/index.js'
import { randomUUID } from 'node:crypto'
import { RUNS_HISTORY_LIMIT } from '../constants/index.js'
import { loadState, saveRuns, withStateLock } from '../storage/index.js'

/** 单次执行结果。 */
export interface ExecuteOutcome {
  ok: boolean
  sessionId?: string
  error?: string
  /** 实际触发的模型选择（调试/展示用）。 */
  model?: string
}

/** 从 workspaceId 解析会话 cwd（未知工作区返回 undefined，交由默认会话）。 */
async function resolveWorkspacePath(ctx: HostContext, workspaceId: string | undefined): Promise<string | undefined> {
  if (!workspaceId)
    return undefined
  try {
    const workspace = ctx.workspaceRegistry?.get?.(workspaceId) as { path?: string } | undefined
    return typeof workspace?.path === 'string' ? workspace.path : undefined
  }
  catch {
    return undefined
  }
}

/**
 * 执行一次定时任务。创建 run 记录（running）→ 建会话 → followup → 等 idle（带超时）
 * → 收敛终态并持久化。
 *
 * @param ctx 宿主根上下文
 * @param task 任务定义
 * @param trigger 触发来源（schedule / manual）
 * @param timeoutMs 单次执行超时（默认 30 分钟；manual 由调用方覆盖）
 * @returns 执行结果（含会话 id）
 */
export async function executeTask(
  ctx: HostContext,
  task: SchedulerTask,
  trigger: RunTrigger,
  timeoutMs = 30 * 60 * 1000,
): Promise<ExecuteOutcome> {
  const runId = `run-${randomUUID()}`
  const scheduledFor = new Date().toISOString()
  const sessionId = `task-${randomUUID()}`
  const cwd = await resolveWorkspacePath(ctx, task.workspaceId)
  await withStateLock(() => {
    const state = loadState()
    state.runs.push({
      id: runId,
      taskId: task.id,
      taskName: task.name,
      trigger,
      status: 'running',
      scheduledFor,
      startedAt: scheduledFor,
      sessionId,
    })
    return saveRuns(state.runs)
  })

  try {
    const presets = ctx.get?.('agentPresets')
    const createOptions: any = {
      sessionId,
      seed: [],
      meta: {
        ...(cwd ? { cwd } : {}),
        ...(task.mode ? { agentPreset: task.mode } : {}),
      },
      agentOptions: task.module ? { model: task.module } : {},
    }
    // 命名的 agent preset：在 setup 阶段挂载（失败回退 meta.agentPreset 语义）。
    if (presets && task.mode && typeof presets.mount === 'function') {
      createOptions.setup = (agentCtx: any) => {
        presets.mount(agentCtx, task.mode)
      }
    }
    const handle = await ctx.agents.create(createOptions)

    // 归属工作区（可选；失败不阻断执行，仅影响会话归类）。
    if (cwd) {
      try {
        const workspace = await ctx.workspaceRegistry?.resolveByPath?.(cwd)
        if (workspace)
          await workspace.attachSession(sessionId)
      }
      catch {
        /* 归类失败忽略：会话仍在 unassigned 工作区 */
      }
    }

    handle.agent.followup({
      id: `message-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: task.prompt }],
      source: { kind: 'user' },
    })

    // 等驱动空闲（会话创建后 agent 处于 idle，followup 唤醒；这里等本轮收敛）。
    await withTimeout(handle.agent.whenIdle(), timeoutMs)

    const outcome: ExecuteOutcome = { ok: true, sessionId, model: task.module }
    await finalizeRun(runId, 'succeeded', outcome)
    return outcome
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const outcome: ExecuteOutcome = { ok: false, sessionId, error: message }
    await finalizeRun(runId, 'failed', outcome)
    return outcome
  }
}

/** 把某次执行更新为终态并持久化（保留最近 RUNS_HISTORY_LIMIT 条）。 */
async function finalizeRun(
  runId: string,
  status: 'succeeded' | 'failed',
  outcome: ExecuteOutcome,
): Promise<void> {
  await withStateLock(() => {
    const state = loadState()
    const run = state.runs.find(r => r.id === runId)
    if (!run)
      return
    run.status = status
    run.finishedAt = new Date().toISOString()
    run.error = outcome.error
    if (outcome.sessionId)
      run.sessionId = outcome.sessionId
    state.runs = state.runs.slice(-RUNS_HISTORY_LIMIT)
    return saveRuns(state.runs)
  })
}

/** 带超时的 Promise 竞速（超时按失败处理由调用方收敛）。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0)
    return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('执行超时')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
