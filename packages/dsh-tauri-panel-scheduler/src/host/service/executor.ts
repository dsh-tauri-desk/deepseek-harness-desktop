/**
 * host/service/executor.ts — 定时任务的执行器：新建独立 Agent 会话 + 注入任务指令。
 *
 * 执行逻辑逐字对齐 MichengAI/dsh-automation 的 src/executor.ts（executeAutomationRun）：
 *   ctx.agents.withoutInitiator(() => ctx.agents.create({...})) → AgentHandle；
 *   setup 回调里 installModelSelection 把模型选择写入 agent 上下文（解决汇编 deployment:persona
 *   段 {{model}} 无值导致运行无反应）、applyUnattendedPermission 应用权限预设、tools.guard 施加
 *   无人值守工具白名单；随后 handle.agent.followup(createUserMessage(...)) 把任务指令作为带来源的
 *   首条用户消息唤醒驱动；Promise.race([whenIdle, deadline, cancellation]) 等收敛（带超时/取消）；
 *   summarizeRun 提取结果与结束原因。
 *
 * 模型绑定：**始终解析一个模型选择**。任务成对 provider/model 则固定之（可带 reasoningEffort），
 * 旧任务仅有 module 则用之，否则回退宿主默认 ctx.agentDefaultModel.currentSelection()（兼容
 * ctx.get('agentDefaultModel') 访问器）。模型经 installModelSelection 绑定，保证汇编可靠。
 */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { HostContext, RunTrigger, SchedulerTask } from '../types/index.js'
import type { PermissionPresetService } from './permission-presets.js'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import process from 'node:process'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { join } from 'pathe'
import { RUNS_HISTORY_LIMIT } from '../constants/index.js'
import { loadState, saveRuns, withStateLock } from '../storage/index.js'
import { schedulerSessionTitle } from './run-title.js'

/** 单次执行结果（scheduler.ts / 路由消费）。 */
export interface ExecuteOutcome {
  ok: boolean
  sessionId?: string
  error?: string
  /** 实际触发的模型选择（调试/展示用）。 */
  model?: string
}

interface SessionEventLike {
  readonly seq: number
  readonly type: string
  readonly data: Record<string, any>
}

const UNATTENDED_TOOL_ALLOWLIST = new Set([
  'run_code',
  'bash',
  'pwsh',
  'read',
  'read_image',
  'write',
  'edit',
  'str_replace_editor',
  'glob',
  'grep',
  'lsp',
  'web_search',
  'web_fetch',
  'skill',
  'session_search',
  'session_trace',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
])

const CANCEL_CONVERGENCE_TIMEOUT_MS = 10_000

/** 对不保证及时响应 AbortSignal 的宿主任务设置第二道退出上限（对齐 MichengAI）。 */
export function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return Promise.race([
      promise.then(() => true, () => false),
      new Promise<false>((resolve) => { timer = setTimeout(resolve, timeoutMs, false) }),
    ])
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer)
  }
}

/** 无人值守工具白名单拦截（对齐 MichengAI unattendedToolGuardReason）。 */
export function unattendedToolGuardReason(name: string, args: unknown): string | undefined {
  if (
    (name === 'bash' || name === 'pwsh')
    && typeof args === 'object' && args !== null
    && (args as Record<string, unknown>).run_in_background === true
  ) {
    return '无人值守运行不允许启动后台进程。'
  }
  return UNATTENDED_TOOL_ALLOWLIST.has(name)
    ? undefined
    : `工具 '${name}' 不在无人值守自动化允许列表中。`
}

/** 先应用官方预设的完整语义，再让无人值守审批 fail-closed（对齐 MichengAI）。 */
export function applyUnattendedPermission(
  presets: PermissionPresetService,
  session: unknown,
  permission: string | undefined,
): void {
  presets.set(session, permission ?? presets.defaultPreset)
  setApprovalPolicy(session, 'never')
}

/** 从会话事件中提取 assistant 文本与 turn 结束原因（对齐 MichengAI summarizeRun）。 */
export function summarizeRun(events: readonly SessionEventLike[], firstSeq: number): {
  readonly text: string
  readonly reason?: Record<string, any>
} {
  let text = ''
  let reason: Record<string, any> | undefined

  for (const event of events) {
    if (event.seq < firstSeq)
      continue
    if (event.type === 'assistant/message') {
      const blocks = (event.data.message?.content ?? []) as readonly { type: string, text?: string }[]
      const joined = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      if (joined)
        text = joined
    }
    else if (event.type === 'turn/end') {
      reason = event.data.reason as Record<string, any>
    }
  }

  return { text, ...(reason ? { reason } : {}) }
}

/**
 * 执行一次定时任务。创建 run 记录（running）→ 建会话 → followup → 等收敛（带超时/取消）→ 汇总结果并持久化。
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

  // 1. 初始化并持久化运行记录
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

  // 辅助内联函数：把某次执行更新为终态并持久化（保留最近 RUNS_HISTORY_LIMIT 条）
  const finalizeRun = (status: 'succeeded' | 'failed' | 'cancelled', outcome: ExecuteOutcome) =>
    withStateLock(() => {
      const state = loadState()
      const run = state.runs.find(r => r.id === runId)
      if (run) {
        run.status = status
        run.finishedAt = new Date().toISOString()
        run.error = outcome.error
        if (outcome.sessionId)
          run.sessionId = outcome.sessionId
        state.runs = state.runs.slice(-RUNS_HISTORY_LIMIT)
        return saveRuns(state.runs)
      }
    })

  try {
    // 2. 解析工作区 CWD
    let cwd: string
    let workspace: { attachSession?: (id: unknown) => Promise<unknown> } | undefined

    if (task.workspaceId) {
      const resolved = ctx.workspaceRegistry?.get?.(task.workspaceId) as
        | { path?: string, status?: () => Promise<string>, attachSession?: (id: unknown) => Promise<unknown> }
        | undefined

      if (!resolved || typeof resolved.path !== 'string') {
        const outcome = { ok: false, sessionId, error: '目标工作区已不存在。' }
        await finalizeRun('failed', outcome)
        return outcome
      }
      if (await resolved.status?.() !== 'ok') {
        const outcome = { ok: false, sessionId, error: '目标工作区目录不可用或已变更。' }
        await finalizeRun('failed', outcome)
        return outcome
      }
      cwd = resolved.path
      workspace = resolved
    }
    else {
      // 未分组任务 cwd：~/.dsh/automations。不注册工作区、不 attachSession——
      // 侧边栏「未分组」桶是客户端按「不在任何 workspace.sessionIds 里」计算的
      // stray 组（dsh-client-ui-workspace groupByWorkspace），无归属会话自动落入。
      const env = process.env.DSH_HOME
      const home = env?.trim() ? env.trim() : join(homedir(), '.dsh')
      cwd = join(home, 'automations')
      await mkdir(cwd, { recursive: true }).catch(() => {})
    }

    // 3. 解析模型选择
    const selection: ModelSelection | undefined = task.provider && task.model
      ? { provider: task.provider, model: task.model, ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}) }
      : ((): ModelSelection | undefined => {
          try {
            return (ctx.get?.('agentDefaultModel') as { currentSelection?: () => ModelSelection })?.currentSelection?.()
          }
          catch { return undefined }
        })()

    // 4. 执行 Agent 任务逻辑
    const agentPreset = task.agentPreset?.trim() || 'standard'
    let handle: any
    let timeout: ReturnType<typeof setTimeout> | undefined
    let agentResult: { status: 'succeeded' | 'failed' | 'cancelled', error?: { code: string, message: string } }

    try {
      const create = () => ctx.agents.create({
        sessionId,
        meta: { cwd, agentPreset },
        agentOptions: selection ? { provider: selection.provider, model: selection.model } : {},
        setup: async (agentCtx: any) => {
          await (ctx.agentPresets as { mount?: (agentCtx: unknown, presetId: string) => Promise<unknown> } | undefined)?.mount?.(agentCtx, agentPreset)
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
          const agent = agentCtx.agent
          if (!agent)
            throw new Error('scheduler setup has no scoped Agent')
          applyUnattendedPermission(ctx.permissionPresets as PermissionPresetService, agent.session, task.permission)
          agentCtx.tools?.guard?.((exec: ToolExecution) => unattendedToolGuardReason(exec.name, exec.arguments))
        },
      })

      handle = ctx.agents.withoutInitiator != null ? await ctx.agents.withoutInitiator(create) : await create()
      await handle.agent.whenIdle()
      if (workspace)
        await workspace.attachSession?.(sessionId)

      // 内联 Pin session title 逻辑
      try {
        const titleService = ctx.get?.('sessionTitle') as { rename?: (target: unknown, value: string) => unknown } | undefined
        titleService?.rename?.(handle.agent.session, schedulerSessionTitle(task.name))
      }
      catch (err) {
        ctx.logger?.warn?.(`dsh-tauri-panel-scheduler: failed to pin session title: ${err instanceof Error ? err.message : String(err)}`)
      }

      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: task.prompt }],
        source: { kind: 'scheduler', taskId: task.id, runId, scheduledFor },
      }))

      let timedOut = false
      const idle = handle.agent.whenIdle()
      const deadline = new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true
          handle?.agent.cancel({ kind: 'hook', reason: 'scheduler run timeout' })
          resolve()
        }, timeoutMs)
      })

      await Promise.race([idle, deadline])

      if (timedOut && !await settlesWithin(idle, CANCEL_CONVERGENCE_TIMEOUT_MS)) {
        agentResult = { status: 'failed', error: { code: 'cancel_convergence_timeout', message: '定时任务取消后未能在安全时限内停止。' } }
      }
      else {
        await (ctx.sessions as { flush: (session: unknown) => Promise<unknown> }).flush(handle.agent.session)
        const outcome = summarizeRun(handle.agent.session.events, firstSeq)

        if (timedOut) {
          agentResult = { status: 'failed', error: { code: 'timeout', message: '定时任务超过最大运行时限。' } }
        }
        else if (outcome.reason?.kind === 'completed') {
          agentResult = { status: 'succeeded' }
        }
        else {
          // 内联解析错误原因逻辑
          const reason = outcome.reason
          const errCode = !reason
            ? 'no_turn_result'
            : reason.kind === 'error'
              ? (typeof reason.error?.code === 'string' ? reason.error.code : 'agent_error')
              : `turn_${String(reason.kind)}`
          const errMsg = !reason
            ? '本次定时任务没有产生完整 turn。'
            : reason.kind === 'error'
              ? (typeof reason.error?.message === 'string' ? reason.error.message : '定时任务 Agent 执行失败。')
              : `定时任务以 ${String(reason.kind)} 结束。`

          agentResult = { status: 'failed', error: { code: errCode, message: errMsg } }
        }
      }
    }
    finally {
      if (timeout !== undefined)
        clearTimeout(timeout)
    }

    // 5. 组装结果并写盘
    const outcome: ExecuteOutcome = {
      ok: agentResult.status === 'succeeded',
      sessionId,
      model: selection?.model,
      ...(agentResult.error ? { error: agentResult.error.message } : {}),
    }

    await finalizeRun(agentResult.status, outcome)
    return outcome
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const outcome: ExecuteOutcome = { ok: false, sessionId, error: message }
    await finalizeRun('failed', outcome)
    return outcome
  }
}
