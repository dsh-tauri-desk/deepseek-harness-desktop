/**
 * src/host/reducer.ts — dsh-tauri-pet 宿主侧「会话增量 → 桌宠展示态」reducer。
 *
 * 【为什么存在】
 * 方案 1（host → rust → pet webview）把转发从 iframe 客户端快照差分（#396 根因）
 * 搬到宿主。宿主只有 `session/event` 这个【增量】总线，没有客户端的已合并快照，
 * 所以必须把增量事件【状态化重建】成桌宠需要的展示态（status/running/activity/…）。
 * 这与 dsh-dafeiyu 的 companion-reducer 是同一类组件，但只投影桌宠白名单字段。
 *
 * 【解耦】
 * 本 reducer 是纯函数式、与运行时 session 形状去耦：它只消费一个明确的最小
 * `SessionPeer` 输入（id/origin/title/running…），由宿主 apply() 从真实 session
 * 对象读取后传入。这样 reducer 可用真实事件形状做 hermetic 单测，而把「宿主
 * session 到底有什么字段」这个无法本会话运行时验证的不确定性隔离到薄薄的
 * apply() 适配层。
 *
 * 【状态模型】按 sessionId 维护一份可显式突变的累计态（type State）：
 * 没有订阅 state 的完整 Txn，而是通过 applyEvent() 微缩进重放得出当前展示视角
 * （与项目既有 diff 逻辑一致：fold 出当前值，再与 lastProjected 引用比对去重）。
 */

/**
 * 最小会话增量事件类型（与 @deepseek-ai/dsh-session 的
 * `SessionEvent = { type, seq, time, data: SessionEventMap[type] }` 契约对齐）。
 * 故意做成本地类型而非从 dsh-session 导入：dsh-tauri-pet 未直接依赖该包，
 * 且把「运行时可能携带的额外字段」隔离，reducer 只消费它声明的最小字段。
 */
export interface PetSessionEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
}

/** 宿主 apply() 从真实 session 对象上读取的最小输入（保持与运行时形状解耦）。 */
export interface PetSessionPeer {
  id: string
  origin?: 'subagent'
  title?: string
  displayTitle?: string
  cwd?: string
  running?: boolean
}

/**
 * 工作状态细分档位（对齐 dsh-pet src/shared/work-status.ts 的 6 档枚举；
 * 索引 = config.jsonc animations.events.workStatus 数组索引，勿在中间插入新档）。
 * 取代旧「粗档 status（error/waiting/running）」成为会话气泡与动画的权威驱动：
 *   - thinking：turn/start 或回合内思考（无工具在跑）
 *   - working：tool/call 工具调用中
 *   - result：tool/result 后整理（无其余工具在跑）
 *   - waiting：approval/asked、问句工具、turn/end blocked（等用户）
 *   - success：turn/end completed（终态档，播一次庆祝后回落）
 *   - error：turn/end error/max-tokens/timeout（终态档）
 * 语义对齐 dsh-pet src/host/work-status.ts 的 reduceWorkStatus，并叠加
 * dsh-dafeiyu companion-reducer 的累计态语义（openTools 有剩 → 保持 working）。
 */
export type PetWorkStatus = 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error'

/** 档位 → events.workStatus 数组索引（与 config.jsonc 顺序严格一致）。 */
export const PET_WORK_STATUS_INDEX: Record<PetWorkStatus, number> = {
  thinking: 0,
  working: 1,
  result: 2,
  waiting: 3,
  success: 4,
  error: 5,
}

/** 工具活动分类（对齐 dsh-dafeiyu companion-reducer 的 toolActivity）：气泡按分类选文案。 */
export type PetToolActivity = 'searching' | 'editing' | 'testing' | 'commanding' | 'using-tool'

/**
 * 桌宠展示态的字段子集（与客户端 projection.ts 的 PET_FORWARDED_FIELDS
 * + PET_FORWARDED_ACTIVITY_FIELD='liveActivity' 对齐；origin 已加入）。
 * workStatus/task/toolActivity 为细分档位新增字段：气泡文案（use-bubble.ts）
 * 与动画切档（pet-config 的 PRESET_SESSION_ANIMATIONS）都以此为驱动。
 */
export interface PetSessionPayload {
  id: string
  origin?: 'subagent'
  title?: string
  displayTitle?: string
  name?: string
  description?: string
  message?: string
  status?: string
  activity?: string
  phase?: string
  running?: boolean
  pendingInteraction?: unknown
  pending?: readonly unknown[]
  lastAgentError?: string
  /** 细分工作状态档位（thinking/working/result/waiting/success/error）。 */
  workStatus?: PetWorkStatus
  /** 当前任务文本（todo/write 的 in_progress/pending 项），供气泡 taskCopy 文案。 */
  task?: string
  /** 当前工具活动分类（working 期间），供气泡 activityCopy 文案。 */
  toolActivity?: PetToolActivity
  liveActivity?: {
    kind: string
    text?: string
    name?: string
    command?: string
    path?: string
    args?: string
  }
}

/** 推理文本滚动尾部窗口字符数：超出后丢弃最早内容，供气泡「思考 · text」实时滚动展示。 */
export const PET_REASONING_TAIL_WINDOW = 120
/** 推理文本推送间隔（毫秒）：最多每 500ms 推送一次尾部内容，避免逐 token 洪泛。 */
export const PET_REASONING_PUSH_INTERVAL_MS = 500

/** 每个会话的全量累计态；fold 出展示 payload 后与 lastSent 深比较去重。 */
export interface PetSessionState {
  id: string
  origin?: 'subagent'
  title?: string
  displayTitle?: string
  cwd?: string
  running: boolean
  turnActive: boolean
  stepActive: boolean
  openTools: Map<string, { name: string, args?: string }>
  /** 累计的 reasoning 文本（滚动尾部窗口，用于 liveActivity.kind==='reasoning'；实时更新时新字从前往后滚动丢弃）。 */
  reasoningTail: string
  /** 最近一条助手普通文本（用于 message）。 */
  assistantText: string
  lastAgentError?: string
  /** 等待用户交互标记（approval/user-question 等）。 */
  waitingKind?: 'approval' | 'user-question' | 'blocked'
  /** 当前待审批的 approval 请求 id（来自 approval/asked，无则不等待审批）。 */
  waitingApprovalId?: string
  /** 当前「等用户回答」的问句工具调用 id（来自 user-question tool/call）。 */
  waitingCallId?: string
  /** 细分工作状态档位（thinking/working/result/waiting/success/error；随事件变化）。 */
  workStatus?: PetWorkStatus
  /** 当前任务文本（todo/write 的 in_progress/pending 项 content，无则为空）。 */
  task?: string
  /** 当前工具活动分类（最近一次 working 工具名分类，供气泡 activityCopy 文案）。 */
  toolActivity?: PetToolActivity
  /** 首次写入时间戳，当前不用于去重（保留给未来生命周期）。 */
  firstSeqAt: number
}

/** 新建一个会话的累计态。 */
export function createPetSessionState(id: string, peer: PetSessionPeer): PetSessionState {
  return {
    id,
    origin: peer.origin,
    title: peer.title,
    displayTitle: peer.displayTitle,
    cwd: peer.cwd,
    running: peer.running ?? false,
    turnActive: false,
    stepActive: false,
    openTools: new Map(),
    reasoningTail: '',
    assistantText: '',
    firstSeqAt: 0,
  }
}

/** 两个 payload 是否深相等（以 fold 出的关键字段表征）。 */
function payloadEqual(a: PetSessionPayload, b: PetSessionPayload): boolean {
  return Object.is(a.status, b.status)
    && Object.is(a.activity, b.activity)
    && Object.is(a.phase, b.phase)
    && Object.is(a.running, b.running)
    && Object.is(a.message, b.message)
    && Object.is(a.lastAgentError, b.lastAgentError)
    && Object.is(a.origin, b.origin)
    && Object.is(a.title, b.title)
    && Object.is(a.displayTitle, b.displayTitle)
    && Object.is(a.workStatus, b.workStatus)
    && Object.is(a.task, b.task)
    && Object.is(a.toolActivity, b.toolActivity)
    && Object.is(a.liveActivity?.kind, b.liveActivity?.kind)
    && Object.is(a.liveActivity?.text, b.liveActivity?.text)
    && Object.is(a.liveActivity?.name, b.liveActivity?.name)
    && Object.is(a.liveActivity?.command, b.liveActivity?.command)
    && Object.is(a.liveActivity?.path, b.liveActivity?.path)
    && Object.is(a.liveActivity?.args, b.liveActivity?.args)
}

/**
 * 把累计态落定为「回合已收尾、空闲」：清掉回合内的一切瞬时态（工具/推理/正文/等待/档位/错误）。
 *
 * `turn/end` 的中断分支与 `agent/status → idle` 兜底共用同一份语义，避免两条收尾路径漂移出
 * 「一条清干净、另一条残留 thinking」这类只在真实中断时复现的差异。
 * @param state - 待落定的会话累计态（就地修改）。
 */
function settleIdle(state: PetSessionState): void {
  state.turnActive = false
  state.stepActive = false
  state.running = false
  state.openTools.clear()
  state.reasoningTail = ''
  state.assistantText = ''
  state.waitingKind = undefined
  state.waitingApprovalId = undefined
  state.waitingCallId = undefined
  state.workStatus = undefined
  state.lastAgentError = undefined
}

/** 会话是否仍处于「回合内」：只有这种状态才允许被 idle 兜底改写（终态档/等待态由 turn/end 落定）。 */
function inTurn(state: PetSessionState): boolean {
  return state.running || state.turnActive || state.stepActive
}

/** 从累计态 fold 出当前展示 payload（只投影桌宠关心的字段）。 */
export function foldPetPayload(state: PetSessionState): PetSessionPayload {
  // 活动优先级：正在等结果的工具调用 > 累计的 reasoning 文本 > 无。
  const liveActivity = state.running && state.openTools.size > 0
    ? toolActivity(
        state.openTools.values().next().value?.name,
        state.openTools.values().next().value?.args,
      )
    : state.running && state.reasoningTail.length > 0
      ? { kind: 'reasoning', text: state.reasoningTail }
      : undefined

  // 细分档位是权威（气泡/动画按它切档）；粗 status 保留作兼容回退。
  let status: string | undefined
  if (state.lastAgentError)
    status = 'error'
  else if (state.waitingKind)
    status = 'waiting'
  else if (state.running)
    status = 'running'
  else if (state.turnActive)
    status = 'running'

  return {
    id: state.id,
    origin: state.origin,
    title: state.title ?? state.displayTitle,
    displayTitle: state.displayTitle,
    message: state.assistantText || undefined,
    status,
    activity: status,
    phase: state.waitingKind,
    running: state.running,
    lastAgentError: state.lastAgentError,
    workStatus: state.workStatus,
    task: state.task,
    toolActivity: state.toolActivity,
    liveActivity,
  }
}

/** 工具名 → liveActivity 展示对象（所有工具统一携带 name+args，展示标签由 use-bubble.ts 侧映射）。 */
function toolActivity(name?: string, args?: string): PetSessionPayload['liveActivity'] {
  return name ? { kind: 'tool', name, args } : { kind: 'tool' }
}

/**
 * 从 tool 事件提取调用 id（与 dsh-dafeiyu companion-reducer 的 toolCallIdOf 对齐）。
 * tool/call 直接给 data.callId；tool/result 的 callId 藏在 data.message 里
 * （source.callId / content[].toolCallId / message.toolCallId | callId），
 * 拿不到时才回退 fallback。
 */
function toolCallIdOf(event: PetSessionEvent, fallback = ''): string {
  const message = (event.data as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
  const content = Array.isArray(message?.content)
    ? (message.content as Array<Record<string, unknown>>).find(item => item.toolCallId)
    : undefined
  const callId = (message?.source as { callId?: unknown } | undefined)?.callId
    ?? content?.toolCallId
    ?? message?.toolCallId
    ?? message?.callId
    ?? (event.data as Record<string, unknown> | undefined)?.callId
  return String(callId ?? fallback)
}

/**
 * 判断一个工具名是否是「等用户回答」的问句工具（approval/澄清/确认类），
 * 而非普通脚本（避免把 code_review/allowlist_files/permission_scan 误判为等待态）。
 * 依据 dsh-dafeiyu companion-reducer 的 isUserQuestionTool：按整体 token 匹配
 * （`\b` 不切分 snake_case），而非子串。
 */
function isUserQuestionTool(name?: string): boolean {
  const value = String(name || '').toLowerCase()
  const tokens = value.split(/[^a-z0-9]+/u).filter(Boolean)
  if (!tokens.length)
    return false

  const asks = new Set(['ask', 'asking', 'request', 'requests', 'requesting', 'require', 'requires', 'prompt', 'needs', 'need', 'seek', 'seeks', 'get', 'gets'])
  const filler = new Set(['for', 'from', 'the', 'a', 'an'])
  const userWords = new Set(['user', 'human', 'me'])
  const nouns = new Set(['question', 'questions', 'input', 'answer', 'answers', 'decision', 'decisions', 'confirmation', 'approval', 'permission', 'authorization', 'authorisation', 'consent', 'clarify', 'clarification', 'help'])

  const hasUserNoun = tokens.some((token, index) =>
    userWords.has(token) && nouns.has(tokens[index + 1] ?? ''),
  )
  const hasNounFromUser = tokens.some((token, index) =>
    nouns.has(token) && tokens[index + 1] === 'from' && userWords.has(tokens[index + 2] ?? ''),
  )
  const hasAsk = tokens.some((token, index) => {
    if (!asks.has(token))
      return false
    let cursor = index + 1
    while (cursor < tokens.length && (filler.has(tokens[cursor]) || userWords.has(tokens[cursor]))) {
      if (userWords.has(tokens[cursor])) {
        const next = tokens[cursor + 1]
        return !next || nouns.has(next)
      }
      cursor += 1
    }
    return cursor < tokens.length && nouns.has(tokens[cursor])
  })
  const strong = tokens.some(token =>
    token === 'authorize' || token === 'authorise' || token === 'consent',
  )
  const submitsPlanForApproval = tokens.some((token, index) =>
    token === 'exit' && tokens[index + 1] === 'plan' && tokens[index + 2] === 'mode',
  )
  return hasUserNoun || hasNounFromUser || hasAsk || strong || submitsPlanForApproval
}

/** 工具名 → 活动分类（对齐 dsh-dafeiyu companion-reducer 的 toolActivity + DSH 实际工具名 pwsh）：气泡按分类选文案。 */
export function toolActivityOf(name?: string): PetToolActivity {
  const value = String(name || '').toLowerCase()
  if (/search|grep|find|glob|web|read|fetch|open/.test(value))
    return 'searching'
  if (/write|edit|patch|replace|create|move|delete/.test(value))
    return 'editing'
  if (/test|check|lint|build|verify/.test(value))
    return 'testing'
  if (/shell|bash|exec|command|terminal|powershell|pwsh/.test(value))
    return 'commanding'
  return 'using-tool'
}

/** 从 todo/write 提取当前任务文本（in_progress 优先、其次 pending；与 dsh-dafeiyu 的 #todo 一致）。 */
export function currentTaskFromTodo(data: Record<string, unknown>): string | undefined {
  const todos = Array.isArray(data.todos) ? (data.todos as Array<{ status?: string, content?: string }>) : []
  const current = todos.find(todo => todo?.status === 'in_progress')
    ?? todos.find(todo => todo?.status === 'pending')
  const content = String(current?.content ?? '').trim()
  return content || undefined
}

/** 一次会话增量事件的 reducer：返回变化后的 payload 或 null（未变化则不转发）。 */
export function reduceSessionEvent(
  state: PetSessionState,
  event: PetSessionEvent,
): PetSessionPayload | null {
  const t = event.type as string
  // 注意：SessionEvent = { type, seq, time, data }；事件载荷都在 event.data 下。
  const data = (event as { data?: Record<string, unknown> }).data ?? {}

  switch (t) {
    case 'turn/start': {
      state.turnActive = true
      state.running = true
      state.reasoningTail = ''
      state.assistantText = ''
      state.waitingKind = undefined
      state.waitingApprovalId = undefined
      state.waitingCallId = undefined
      // 新回合开始：清上一回合的终态错误与任务残留，避免「上一轮报错、本轮继续跑」
      // 时 use-bubble 仍按 lastAgentError 判 failed 收起气泡。
      state.lastAgentError = undefined
      state.workStatus = 'thinking'
      state.task = undefined
      break
    }
    case 'step/start':
    case 'assistant/chunk': {
      state.stepActive = true
      state.running = true
      if (t === 'step/start' && !state.waitingKind && state.openTools.size === 0)
        state.workStatus = 'thinking'
      if (t === 'assistant/chunk') {
        // StreamChunk 真实形状：reasoning-delta / text-delta 携带增量 text（非 chunk.content）。
        const chunk = data.chunk as { type?: string, text?: string } | undefined
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text) {
          // 滚动尾部窗口：只保留最近的文本，新内容不断挤掉最早的，气泡即可实时滚动更新。
          state.reasoningTail = (state.reasoningTail + chunk.text).slice(-PET_REASONING_TAIL_WINDOW)
          // 回合内思考（无工具在跑）→ thinking：气泡显示「正在认真想下一步」。
          if (!state.waitingKind && state.openTools.size === 0)
            state.workStatus = 'thinking'
          // reasoning 需要实时浮出（气泡「思考 · text」），但不逐 token 洪泛：仅当
          // 尾部文本实际变化才折叠（下方 foldable 判定对 assistant/chunk 在本分支处理）。
          return foldPetPayload(state)
        }
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text)
          state.assistantText = (state.assistantText + chunk.text).slice(-1000)
        // 其余 chunk 类型（block-start/finish/usage/空帧）只累积状态，不转发。
        return null
      }
      break
    }
    case 'assistant/message': {
      state.stepActive = true
      state.running = true
      // AssistantMessage.content 是 ContentBlock[]（text/reasoning/tool-call…），拼接 text 块。
      const blocks = (data.message as { content?: unknown[] } | undefined)?.content as Array<{ type?: string, text?: string }> | undefined
      const text = blocks?.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
      if (text)
        state.assistantText = text.slice(-1000)
      if (!state.waitingKind && state.openTools.size === 0)
        state.workStatus = 'thinking'
      break
    }
    case 'tool/call': {
      const tc = data as { callId?: string, name?: string, arguments?: string }
      // 携带原始 arguments JSON 字符串，供气泡 getLiveActivity 解析 command/path。
      const name = tc.name
      if (name)
        state.openTools.set(tc.callId ?? name, { name, args: tc.arguments })
      state.running = true
      // 问句工具：等用户回答（approval/澄清/确认），展示为「等待中」而非「思考中」。
      if (name && isUserQuestionTool(name)) {
        state.waitingKind = 'user-question'
        state.waitingCallId = tc.callId ?? name
        state.workStatus = 'waiting'
      }
      else {
        if (name)
          state.toolActivity = toolActivityOf(name)
        state.workStatus = 'working'
      }
      break
    }
    case 'tool/result': {
      // tool/result 的 callId 藏在 data.message 下，能拿到就精确删对应工具；
      // 拿不到（旧形状）则清空「当前在等待结果的工具」—— 刚结束的工具应退场。
      const callId = toolCallIdOf(event)
      if (callId) {
        state.openTools.delete(callId)
        if (callId === state.waitingCallId) {
          state.waitingKind = undefined
          state.waitingCallId = undefined
        }
      }
      else {
        state.openTools.clear()
      }
      // 注意：工具级失败（data.error）不写入 lastAgentError —— 那是回合级终态语义，
      // 写入后 use-bubble 会把本会话判为 failed 并 4s 收起气泡，而回合仍在跑（对齐
      // dsh-dafeiyu：tool/result 错误只发 toolError 提示，状态回 WORKING/THINKING，
      // 不污染终态）。回合真正失败由 turn/end(error) 负责记录。
      // 工具完成回整理（dsh-pet：tool/result → result 档）；仍有工具在跑则保持 working。
      if (state.openTools.size > 0) {
        state.workStatus = 'working'
        state.toolActivity = toolActivityOf(state.openTools.values().next().value?.name)
      }
      else {
        state.workStatus = state.waitingKind ? 'waiting' : 'result'
      }
      break
    }
    case 'approval/asked': {
      // 待审批（plan/tool/sandbox 审批）：展示为「等待中」，而非「思考中」。
      const id = String(data.id ?? '')
      state.waitingKind = 'approval'
      state.waitingApprovalId = id
      state.running = true
      state.workStatus = 'waiting'
      break
    }
    case 'approval/decided': {
      const id = String(data.id ?? '')
      if (state.waitingApprovalId && id === state.waitingApprovalId) {
        state.waitingApprovalId = undefined
        state.waitingKind = undefined
        // 审批通过后继续干活：还有工具在跑 → working；否则回思考。
        state.workStatus = state.openTools.size > 0 ? 'working' : 'thinking'
      }
      else {
        // 与当前记录不匹配：状态未变，不转发。
        return null
      }
      break
    }
    case 'user/message': {
      // 用户消息（含合成上下文）只标记会话活跃，不写入展示 message，
      // 避免把用户提示当成助手描述。展示 message 只来自 assistant/message。
      state.running = true
      state.turnActive = true
      // 若此前在等用户回答（问句工具），用户已应答 → 清除等待态，继续干活。
      if (state.waitingCallId !== undefined) {
        state.waitingKind = undefined
        state.waitingCallId = undefined
        state.workStatus = state.openTools.size > 0 ? 'working' : 'thinking'
      }
      break
    }
    case 'todo/write': {
      // 任务清单更新：当前任务（in_progress/pending）作为气泡 taskCopy 文案来源。
      const task = currentTaskFromTodo(data)
      if (task !== state.task) {
        state.task = task
        // task 变化即转发（供气泡展示「正在处理 xxx」）；其余字段不动。
        return foldPetPayload(state)
      }
      return null
    }
    case 'session/title': {
      // 会话标题日志事件：覆盖身份字段（title/displayTitle 取同一值；origin 由 peer 权威覆盖）。
      const title = (data as { title?: string }).title
      if (typeof title === 'string' && title) {
        state.title = title
        state.displayTitle = title
      }
      break
    }
    case 'turn/end': {
      state.turnActive = false
      state.stepActive = false
      state.running = false
      state.openTools.clear()
      state.reasoningTail = ''
      state.assistantText = ''
      state.waitingApprovalId = undefined
      state.waitingCallId = undefined
      const reason = (data as { reason?: { kind?: string } }).reason
      if (reason?.kind === 'blocked') {
        // 会话被阻塞等待用户处理：展示为「等待中」。
        state.waitingKind = 'blocked'
        state.workStatus = 'waiting'
      }
      else {
        state.waitingKind = undefined
        const kind = reason?.kind
        if (kind === 'completed') {
          // 回合完成（终态档）：播一次庆祝动画；lastAgentError 清空（本轮无错）。
          state.workStatus = 'success'
          state.lastAgentError = undefined
        }
        else if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') {
          // 失败/达上限（终态档）：record error 信息供气泡展示失败详情。
          state.workStatus = 'error'
          const errBody = (data as { reason?: { error?: { message?: string } } }).reason
          state.lastAgentError = errBody?.error?.message ?? kind
        }
        else {
          // aborted/interrupted/未知：回合中断，静默回空闲（绝不残留上一档，防止「一直 working」挂死）。
          // 手动取消是用户主动中断而非失败：不得写入 lastAgentError，否则 use-bubble 下一帧
          // 判 failed 弹「失败：aborted」toast。与 agent/status idle 兜底共用 settleIdle。
          settleIdle(state)
        }
      }
      break
    }
    default:
      break
  }

  // 只在「我们关心的变化」边界 fold+去重，避免高频转发 —— 这正是 #396 的客户端版根因，
  // host 版同样要防。assistant/chunk（reasoning/text 增量）只做状态累积、不在此 fold
  // （逐 token 转发会产生洪泛），推理/正文文本在 assistant/message 等边界一并折叠。
  const foldable = t === 'turn/start'
    || t === 'step/start'
    || t === 'assistant/message'
    || t === 'tool/call'
    || t === 'tool/result'
    || t === 'user/message'
    || t === 'turn/end'
    || t === 'session/title'
    || t === 'approval/asked'
    || t === 'approval/decided'
  if (!foldable)
    return null

  return foldPetPayload(state)
}

/**
 * 便捷包装：维持 per-session 累计态 + lastSent 去重，只在展示态真的变化时回调。
 * 推理文本（assistant/chunk 的 reasoning-delta）按 PET_REASONING_PUSH_INTERVAL_MS 节流，
 * 避免逐 token 洪泛 —— 状态实时累积，但最多每 500ms 推送一次最新尾部。
 * @param handle - 变化时回调 (action, payload)。
 * @param opts - 可选注入时钟（默认 Date.now），供单测 hermetic 推进时间。
 * @param opts.now - 时钟函数（ms），节流窗口判定用；默认 Date.now。
 */
export function createPetSessionReducer(
  handle: (action: 'create' | 'update' | 'remove', payload: PetSessionPayload) => void,
  opts?: { now?: () => number },
) {
  const now = opts?.now ?? (() => Date.now())
  const states = new Map<string, PetSessionState>()
  const lastSent = new Map<string, PetSessionPayload>()
  const lastReasoningPushAt = new Map<string, number>()

  return {
    /** 会话出生：建态并 push create。 */
    create(peer: PetSessionPeer): void {
      const state = createPetSessionState(peer.id, peer)
      states.set(peer.id, state)
      const payload = foldPetPayload(state)
      lastSent.set(peer.id, payload)
      handle('create', payload)
    },
    /** 增量事件驱动：更新态，变化才 push update。 */
    apply(peer: PetSessionPeer, event: PetSessionEvent): void {
      let state = states.get(peer.id)
      if (!state) {
        state = createPetSessionState(peer.id, peer)
        states.set(peer.id, state)
      }
      // 每次事件后用 peer 最新身份字段覆盖（title/origin/running 是权威来源）。
      state.title = peer.title ?? state.title
      state.displayTitle = peer.displayTitle ?? state.displayTitle
      state.origin = peer.origin ?? state.origin
      state.cwd = peer.cwd ?? state.cwd

      const payload = reduceSessionEvent(state, event)
      if (!payload)
        return
      // 推理文本节流：仅对流式 reasoning-delta 生效（边界事件如 turn/end、tool 转换
      // 立即推送）；窗口内只累积状态，跳过转发，窗口到达后再推最新尾部。
      if (event.type === 'assistant/chunk' && payload.liveActivity?.kind === 'reasoning') {
        const t = now()
        const last = lastReasoningPushAt.get(peer.id) ?? 0
        if (t - last < PET_REASONING_PUSH_INTERVAL_MS)
          return
        lastReasoningPushAt.set(peer.id, t)
      }
      const previous = lastSent.get(peer.id)
      if (previous && payloadEqual(previous, payload))
        return
      lastSent.set(peer.id, payload)
      handle('update', payload)
    },
    /**
     * agent 空闲兜底（宿主 `agent/status → idle`）。
     *
     * 【为什么必须有】`turn/end` 不是「回合收尾」的可靠信号：核心在异常收尾时可能**永远不追加**
     * 它——真实现场（0.1.5-rc.1，用户中止一个刚起流的会话）里日志只有 `assistant/attempt` +
     * `step/end`，`turn/end` 直到 2.5 分钟后会话被重新加载时才由崩溃修复以 `interrupted` 补写；
     * 而崩溃修复属于构造 seed，不会再走 `session/event`。桌宠只认 `turn/end`，于是永远停在
     * 「思考中」气泡 + 循环工作动画（用户报告：会话被中止后 toast 跟动画一直持续）。
     * turnrewind 宿主侧对此早已有同样的 idle 兜底，这里补齐桌宠这一侧。
     *
     * 【为什么限定 inTurn】`agent/status → idle` 总是紧跟在 `turn/end` 之后（同一轮收尾：
     * turn/end 在 `finally` 里先落定，driver 再切 idle）。只有当回合内标志仍然成立（说明
     * `turn/end` 根本没到）才改写，避免把刚由 turn/end 写好的终态档（success 庆祝 / error 失败）
     * 与 blocked 等待态立刻清掉、掐断刚弹出的气泡与一次性动画。
     * @param id - 进入空闲的会话 id（无累计态或已非回合内时静默忽略）。
     */
    idle(id: string): void {
      const state = states.get(id)
      if (state === undefined || !inTurn(state))
        return
      settleIdle(state)
      const payload = foldPetPayload(state)
      const previous = lastSent.get(id)
      if (previous && payloadEqual(previous, payload))
        return
      lastSent.set(id, payload)
      handle('update', payload)
    },
    /** 会话消失：push remove 并清态。 */
    remove(id: string): void {
      states.delete(id)
      lastSent.delete(id)
      lastReasoningPushAt.delete(id)
      handle('remove', { id })
    },
    /** 清空（宿主 gate 关闭时）。 */
    clear(): void {
      states.clear()
      lastSent.clear()
      lastReasoningPushAt.clear()
    },
  }
}
