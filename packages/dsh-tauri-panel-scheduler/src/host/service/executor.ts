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

interface TextBlock { readonly type: string, readonly text?: string }
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
  if ((name === 'bash' || name === 'pwsh')
    && typeof args === 'object' && args !== null
    && (args as Record<string, unknown>).run_in_background === true) {
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
  let started = false
  let text = ''
  let reason: Record<string, any> | undefined
  for (const event of events) {
    if (event.seq < firstSeq)
      continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started)
      continue
    if (event.type === 'assistant/message') {
      const blocks = (event.data.message?.content ?? []) as readonly TextBlock[]
      const joined = blocks.filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('')
      if (joined !== '')
        text = joined
    }
    if (event.type === 'turn/end')
      reason = event.data.reason as Record<string, any>
  }
  return { text, ...(reason === undefined ? {} : { reason }) }
}

function reasonError(reason: Record<string, any> | undefined): { readonly code: string, readonly message: string } {
  if (reason === undefined)
    return { code: 'no_turn_result', message: '本次定时任务没有产生完整 turn。' }
  if (reason.kind === 'error') {
    return {
      code: typeof reason.error?.code === 'string' ? reason.error.code : 'agent_error',
      message: typeof reason.error?.message === 'string'
        ? reason.error.message
        : '定时任务 Agent 执行失败。',
    }
  }
  return { code: `turn_${String(reason.kind)}`, message: `定时任务以 ${String(reason.kind)} 结束。` }
}

function getOptionalService(ctx: HostContext, name: string): unknown {
  try {
    return ctx.get?.(name)
  }
  catch {
    return undefined
  }
}

/**
 * 解析本次执行的模型选择：任务成对 provider/model 则固定之，否则回退宿主默认。
 *  对齐 MichengAI：`target.provider !== null && target.model !== null ? 固定 : fallback`。
 */
function resolveModelSelection(ctx: HostContext, task: SchedulerTask): ModelSelection | undefined {
  if (task.provider && task.model)
    return { provider: task.provider, model: task.model, ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}) }
  // 从可选注入读取；未注入时必须回退为 undefined，不能直接访问属性。
  let service: { currentSelection?: () => ModelSelection } | undefined
  try {
    service = getOptionalService(ctx, 'agentDefaultModel') as { currentSelection?: () => ModelSelection } | undefined
  }
  catch {
    return undefined
  }
  return service?.currentSelection?.()
}

/**
 * 执行一次定时任务。创建 run 记录（running）→ 建会话（镜像 MichengAI 的 setup/install/guard）→
 * followup → 等收敛（带超时/取消）→ 汇总结果并持久化。
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
    // 镜像 MichengAI executeAutomationRun 的前置工作区校验：目标工作区不存在或不可用
    // 时运行直接失败（不静默降级）；未分组（无 workspaceId）任务按我们的方式回退
    // 宿主 home 下的 automations 目录。
    let cwd: string
    let workspace: { attachSession?: (id: unknown) => Promise<unknown> } | undefined
    if (task.workspaceId) {
      const resolved = ctx.workspaceRegistry?.get?.(task.workspaceId) as
        | { path?: string, status?: () => Promise<string>, attachSession?: (id: unknown) => Promise<unknown> }
        | undefined
      if (resolved === undefined || typeof resolved.path !== 'string') {
        const outcome: ExecuteOutcome = { ok: false, sessionId, error: '目标工作区已不存在。' }
        await finalizeRun(runId, 'failed', outcome)
        return outcome
      }
      if (await resolved.status?.() !== 'ok') {
        const outcome: ExecuteOutcome = { ok: false, sessionId, error: '目标工作区目录不可用或已变更。' }
        await finalizeRun(runId, 'failed', outcome)
        return outcome
      }
      cwd = resolved.path
      workspace = resolved
    }
    else {
      // 未分组任务：把 automations 目录注册为 DSH 工作区再挂会话。侧边栏按工作区实体
      // 分组收录会话，未注册路径上的会话永远不可见；create 幂等（同 canonical path
      // 重复调用返回既有记录，不改标题），因此每次执行直接调用即可。
      cwd = await ungroupedCwd()
      workspace = await ctx.workspaceRegistry.create(cwd, '定时任务')
    }

    const selection = resolveModelSelection(ctx, task)
    const session = await runSchedulerAgent(ctx, task, runId, sessionId, scheduledFor, cwd, workspace, selection, timeoutMs)
    const outcome: ExecuteOutcome = {
      ok: session.status === 'succeeded',
      sessionId,
      model: selection?.model,
      ...(session.error === undefined ? {} : { error: session.error.message }),
    }
    await finalizeRun(runId, session.status, outcome)
    return outcome
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const outcome: ExecuteOutcome = { ok: false, sessionId, error: message }
    await finalizeRun(runId, 'failed', outcome)
    return outcome
  }
}

interface AgentRunResult {
  status: 'succeeded' | 'failed' | 'cancelled'
  error?: { code: string, message: string }
}

/** 镜像 MichengAI executeAutomationRun 的建会话 + 驱动 + 收敛核心（不含 run 持久化）。 */
async function runSchedulerAgent(
  ctx: HostContext,
  task: SchedulerTask,
  runId: string,
  sessionId: string,
  scheduledFor: string,
  cwd: string,
  workspace: { attachSession?: (id: unknown) => Promise<unknown> } | undefined,
  selection: ModelSelection | undefined,
  timeoutMs: number,
): Promise<AgentRunResult> {
  // 镜像 MichengAI service.ts:576：agentPreset 缺省 'standard'；meta 始终携带 cwd + agentPreset
  // （工作区侧边栏按会话 header 的 canonical-cwd 收录，agentPreset 决定汇编预设）。
  const agentPreset = task.agentPreset?.trim() || 'standard'
  const sid = sessionId
  let handle: any
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const create = () => ctx.agents.create({
      sessionId: sid,
      meta: { cwd, agentPreset },
      agentOptions: selection ? { provider: selection.provider, model: selection.model } : {},
      setup: async (agentCtx: any) => {
        // 镜像 MichengAI：先挂载会话预设，再绑定模型选择（解决汇编 {{model}} 无值）。
        await (ctx.agentPresets as { mount?: (agentCtx: unknown, presetId: string) => Promise<unknown> } | undefined)
          ?.mount?.(agentCtx, agentPreset)
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
        const agent = agentCtx.agent
        if (agent === undefined)
          throw new Error('scheduler setup has no scoped Agent')
        applyUnattendedPermission(ctx.permissionPresets as PermissionPresetService, agent.session, task.permission)
        agentCtx.tools?.guard?.((exec: ToolExecution) => unattendedToolGuardReason(exec.name, exec.arguments))
      },
    })
    handle = ctx.agents.withoutInitiator != null
      ? await ctx.agents.withoutInitiator(create)
      : await create()
    await handle.agent.whenIdle()
    if (workspace !== undefined)
      await workspace.attachSession?.(sid)
    pinSessionTitle(ctx, handle.agent.session, schedulerSessionTitle(task.name, scheduledFor))
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
    // 镜像 MichengAI：取消后未能在安全时限内收敛则显式失败。
    if (timedOut && !await settlesWithin(idle, CANCEL_CONVERGENCE_TIMEOUT_MS)) {
      return { status: 'failed', error: { code: 'cancel_convergence_timeout', message: '定时任务取消后未能在安全时限内停止。' } }
    }
    if (timeout !== undefined)
      clearTimeout(timeout)
    // sessions 已在 inject 列表：直接 flush 把会话（含 header cwd）持久化，
    // 工作区侧边栏按 canonical-cwd header 索引收录的前提。镜像 MichengAI ctx.sessions.flush。
    await (ctx.sessions as { flush: (session: unknown) => Promise<unknown> }).flush(handle.agent.session)
    const outcome = summarizeRun(handle.agent.session.events, firstSeq)
    if (timedOut) {
      return { status: 'failed', error: { code: 'timeout', message: '定时任务超过最大运行时限。' } }
    }
    if (outcome.reason?.kind === 'completed')
      return { status: 'succeeded' }
    return { status: 'failed', error: reasonError(outcome.reason) }
  }
  finally {
    if (timeout !== undefined)
      clearTimeout(timeout)
    if (handle !== undefined)
      await settlesWithin(handle.dispose().catch(() => {}), CANCEL_CONVERGENCE_TIMEOUT_MS)
  }
}

/**
 * 未分组（无 workspaceId）任务的 cwd：宿主 home 下的 automations 目录
 * （~/.dsh/automations，dev 构建为 ~/.dsh.dev/automations；优先 $DSH_HOME），
 * 目录不存在时创建——与 dsh-automation 的未分组 cwd 语义一致。
 */
async function ungroupedCwd(): Promise<string> {
  const env = process.env.DSH_HOME
  const home = env && env.trim() ? env.trim() : join(homedir(), '.dsh')
  const dir = join(home, 'automations')
  await mkdir(dir, { recursive: true }).catch(() => {})
  return dir
}

/** 会话标题钉住（对齐 MichengAI pinAutomationSessionTitle：可选查询，失败仅告警）。 */
function pinSessionTitle(ctx: HostContext, session: unknown, title: string): void {
  const service = ctx.get?.('sessionTitle') as { rename?: (target: unknown, value: string) => unknown } | undefined
  if (service === undefined || typeof service.rename !== 'function')
    return
  try {
    service.rename(session, title)
  }
  catch (error: unknown) {
    ctx.logger?.warn?.(`dsh-tauri-panel-scheduler: failed to pin session title: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 把某次执行更新为终态并持久化（保留最近 RUNS_HISTORY_LIMIT 条）。 */
async function finalizeRun(
  runId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
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
