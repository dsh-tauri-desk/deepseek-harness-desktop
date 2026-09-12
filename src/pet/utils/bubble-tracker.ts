import type { ToastContentValue } from '@heroui/react'
import type { Motion } from 'dsh-pet-component'
import { toast } from '@/utils/toast'
import { IS_ZH, sessionTitle, statusCopy, taskCopy, toolActivityGroup } from './bubble'

/**
 * 会话气泡状态机（桌宠窗口专用，**不依赖 React**）。
 *
 * DSH 把每个会话的原始快照经 `session:create|update|remove` 事件推给桌宠窗口；
 * 这里把这些快照收敛成：
 * - 一张「会话 → toast」映射（创建/原地更新/定时收起）；
 * - 一个多会话聚合出的动作档位（`Motion`），经 `onMotion` 回吐给 React 层。
 *
 * 之所以从 `use-bubble.ts` 里抽出来：原实现把状态容器与三个 `listen` 一起塞进
 * 一个 500 行的 `useEffect`，既无法单测，也让「订阅」这件事被埋没。现在：
 * - React 侧只负责 `useListen` ×3 与 `useUnmount` 释放；
 * - 本文件是纯逻辑（除 `toast` 这一外部副作用），可单独推理/测试。
 */

export interface BubbleSession {
  [key: string]: unknown
  id: string
}

type SessionAction = 'create' | 'remove' | 'update'

export interface BubbleTracker {
  /** 喂入一个会话事件载荷（原始快照或 `{ session }` 包装）。 */
  apply: (payload: unknown, action: SessionAction) => void
  /** 释放所有定时器与 toast；可在 StrictMode 的双挂载间重复调用。 */
  dispose: () => void
}

const FAILED_BUBBLE_TIMEOUT = 4000
const REVIEW_BUBBLE_TIMEOUT = 2500
const SUCCESS_TOAST_TIMEOUT = 3000
const FAILED_PULSE_TTL = 1800
/**
 * 终态档（success/error）聚合保持时长：对齐 dsh-pet 的 BUBBLE_DURATION_MS=10000
 * （终态动画播一次 + 10s 收气泡）语义。不得复用 SUCCESS_TOAST_TIMEOUT(3s)——成功
 * 终态动画（如 雀跃庆祝）实际播放时长超过 3s 时，聚合状态提前回落会让 app.tsx 的
 * useWatch 调 pet.clear() 掐断未播完的动画（用户报告：成功动画没播完就换回待机）。
 * 动画播完由视频 ended（handleEnded → 清 override）自然回落，toast 收起仍走
 * scheduleHide 的独立 3s（SUCCESS_TOAST_TIMEOUT），二者互不影响。
 */
const TERMINAL_PULSE_TTL = 10000
/** 会话完成/变空闲后保留的时长：超过即从会话表沉淀，防止 durable subagent 等永不发 remove 的会话无界积累。 */
const IDLE_SESSION_RETENTION = 5000
/**
 * 聚合状态下发合并窗口（ms）：突发到达的多会话状态变更只取窗内「最新」值下发一次。
 * 多会话并行时每个 session:update 事件都走 updateAgg，若每档都立即 setStatus，
 * app.tsx 的 useWatch 会对逐个差异档位调用 pet.change 重载动画——工作档位
 * （thinking 20 / result 25 / working 30）交错抖动会让桌宠动画被频繁切回/重放。
 * 统一合并：窗内只刷新 pendingAgg，到期一次性下发最新聚合态，中间档位全部丢弃。
 */
const STATUS_COALESCE_MS = 100

/** 工具名 → toast 展示标签（沿用既有风格：英文工具名大写 / 中文动词）。 */
const TOOL_LABELS: Record<string, string> = {
  pwsh: 'Pwsh',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  read: '读取',
  read_image: '看图',
  write: '写入',
  edit: '编辑',
  str_replace_editor: '编辑',
  web_search: '搜索',
  web_fetch: '抓取',
  think: '思考',
  skill: '技能',
}

/** 工具名 → 从 args（JSON 字符串）提取展示明细的键，按优先级取第一个非空值。 */
const TOOL_ARG_KEYS: Record<string, readonly string[]> = {
  pwsh: ['command'],
  bash: ['command'],
  grep: ['pattern'],
  glob: ['pattern'],
  read: ['file_path', 'path'],
  read_image: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  str_replace_editor: ['file_path', 'path'],
  web_search: ['queries', 'query'],
  web_fetch: ['url'],
  think: ['thought'],
  skill: ['name'],
}

/** 状态优先级映射，数值越大优先级越高（对齐 dsh-dafeiyu statePriority：等待>错误>工作>思考>空闲）。 */
const STATUS_PRIORITY: Record<string, number> = {
  'waiting': 60,
  'error': 50,
  'failed': 45,
  'review': 40,
  'working': 30,
  'result': 25,
  'thinking': 20,
  'running': 12,
  'success': 10,
  'idle': 0,
  'turn': 0,
  'moving-left': 0,
  'moving-right': 0,
  'waving': 0,
}

/** 细分工作档位（host reducer workStatus 输出）：与 `dsh-pet-component` 的动作名同名。 */
const WORK_STATUSES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'] as const

type WorkStatus = (typeof WORK_STATUSES)[number]

/** 统一解析原始会话对象 */
function rawSession(payload: unknown): BubbleSession | undefined {
  if (!payload || typeof payload !== 'object')
    return undefined
  const value = payload as Record<string, unknown>
  const session = (value.session && typeof value.session === 'object' ? value.session : value) as Record<string, unknown>
  const id = session.id ?? session.sessionId
  return typeof id === 'string' && id.length > 0 ? { ...session, id } : undefined
}

/** 提取单个会话的状态（细分档优先，忽略底层恢复逻辑）。 */
function sessionStatus(session: BubbleSession, ignoreError = false): Motion | undefined {
  // 细分工作档位（host reducer 权威）：thinking/working/result/waiting/success/error
  const work = session.workStatus as unknown
  if (WORK_STATUSES.includes(work as WorkStatus)) {
    // error/success 是终态档；pulse 过期（ignoreError）后回落底层推导，不残留失败/成功视觉。
    if (ignoreError && (work === 'error' || work === 'success'))
      return undefined
    return work as Motion
  }

  const value = session.status ?? session.activity ?? session.phase

  // 终态错误判定只在回合已结束（running !== true）时生效：工具级失败/旧快照的
  // lastAgentError 若与 running=true 并存，说明回合仍在跑（agent 捕获错误继续），
  // 此时绝不判 failed 收起气泡（用户报告：会话还在跑 toast 却消失了）。
  // lastAgentError==='aborted' 是旧版插件宿主（未重新部署 dist 的安装）把手动取消误记为
  // 错误的兜底豁免：取消是用户主动中断而非失败，不弹「失败：aborted」。新版宿主已不再下发该值。
  const agentError = session.lastAgentError
  if (!ignoreError && session.running !== true && (value === 'failed' || value === 'error' || (Boolean(agentError) && agentError !== 'aborted'))) {
    return 'failed'
  }
  if (value === 'review' || value === 'reviewing' || value === 'plan-review') {
    return 'review'
  }

  const hasInteraction = Boolean(session.pendingInteraction)
  const hasPending = Array.isArray(session.pending) ? session.pending.length > 0 : Boolean(session.pending)

  if (value === 'waiting' || value === 'pending' || value === 'blocked' || hasInteraction || hasPending) {
    return 'waiting'
  }

  if (value === 'running' || value === 'working' || value === 'thinking' || session.running === true) {
    return 'running'
  }

  return undefined
}

/** 计算聚合最高优先级状态（零额外堆内存分配） */
function statusOf(
  sessions: ReadonlyMap<string, BubbleSession>,
  failedUntil: ReadonlyMap<string, number>,
  now: number,
): Motion | undefined {
  let highestStatus: Motion | undefined
  let maxPriority = 0

  for (const session of sessions.values()) {
    let status = sessionStatus(session)
    if (status === 'failed' || status === 'error' || status === 'success') {
      const deadline = failedUntil.get(session.id)
      if (deadline === undefined || now >= deadline) {
        status = sessionStatus(session, true) // 底层恢复状态
      }
    }

    if (status) {
      const priority = STATUS_PRIORITY[status] ?? 0
      if (priority > maxPriority) {
        maxPriority = priority
        highestStatus = status
        if (maxPriority === STATUS_PRIORITY.waiting)
          break // 'waiting' 为最高优先级，提前终止遍历
      }
    }
  }
  return highestStatus
}

/** 格式化空白字符 */
function sanitizeText(str: string): string {
  return str.replace(/\s+/g, ' ').trim()
}

/** 从工具 args（JSON 字符串）按优先级提取展示明细；解析失败或无匹配键时返回 undefined。 */
function toolArgDetail(tool: string, args: unknown): string | undefined {
  if (typeof args !== 'string' || !args)
    return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  }
  catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined

  const record = parsed as Record<string, unknown>
  for (const key of TOOL_ARG_KEYS[tool] ?? ['file_path', 'path']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return sanitizeText(value)
    }
    if (Array.isArray(value)) {
      const first = value.find(item => typeof item === 'string' && item.trim())
      if (typeof first === 'string' && first.trim()) {
        return sanitizeText(first)
      }
    }
  }
  return undefined
}

/** 生成 Toast 渲染数据（对齐 dsh-dafeiyu：优先失败详情 → 任务文案 → 工具/思考活动 → 档位状态文案）。 */
function toastContent(session: BubbleSession, status: Motion) {
  const getFirstString = (...items: unknown[]): string | undefined => {
    for (const item of items) {
      if (typeof item === 'string' && item.trim().length > 0) {
        return item.trim()
      }
    }
    return undefined
  }

  const getLiveActivity = (): string | undefined => {
    if (status !== 'running' && status !== 'thinking' && status !== 'working' && status !== 'result') {
      return undefined
    }
    if (!session.liveActivity || typeof session.liveActivity !== 'object') {
      return undefined
    }

    const { kind, text, name, args } = session.liveActivity as Record<string, unknown>

    if (kind === 'reasoning' && typeof text === 'string' && text.trim()) {
      return IS_ZH ? `思考 · ${sanitizeText(text)}` : `Thought · ${sanitizeText(text)}`
    }

    if (kind === 'tool' && typeof name === 'string' && name) {
      const tool = name.toLowerCase()
      const label = TOOL_LABELS[tool]
      if (!label)
        return IS_ZH ? `工具调用 · ${name}` : `Tool · ${name}`

      const detail = toolArgDetail(tool, args)
      return detail ? `${label} · ${detail}` : label
    }

    return undefined
  }

  const isSub = session.origin === 'subagent'
  const title = sessionTitle(session)
  // 会话稳定 seed（同会话同档位文案恒定，跨档位切换自然换句；对齐 dsh-dafeiyu statusCopy(seed)）。
  const seed = session.id
  const statusTextMap: Record<string, string> = {
    'think': IS_ZH ? '思考中' : 'Thinking',
    'thinking': IS_ZH ? '思考中' : 'Thinking',
    'working': IS_ZH ? '处理中' : 'Working',
    'result': IS_ZH ? '整理中' : 'Organizing',
    'waiting': IS_ZH ? '等待中' : 'Waiting',
    'running': isSub ? (IS_ZH ? '运行中' : 'Running') : (IS_ZH ? '思考中' : 'Thinking'),
    'review': IS_ZH ? '待审阅' : 'Review',
    'failed': IS_ZH ? '失败' : 'Failed',
    'error': IS_ZH ? '出错' : 'Error',
    'success': IS_ZH ? '已完成' : 'Done',
    'idle': IS_ZH ? '空闲' : 'Idle',
    'turn': IS_ZH ? '空闲' : 'Idle',
    'moving-left': IS_ZH ? '空闲' : 'Idle',
    'moving-right': IS_ZH ? '空闲' : 'Idle',
    'waving': IS_ZH ? '空闲' : 'Idle',
  }

  const statusText = statusTextMap[status] ?? (IS_ZH ? '空闲' : 'Idle')
  // 档位状态文案：waiting 分 approval/user-question 两档，working 按工具活动分类选句。
  const fallbackCopy = status === 'waiting'
    ? (session.phase === 'approval' ? statusCopy('approval', seed) : statusCopy('waiting', seed))
    : status === 'working'
      ? statusCopy(toolActivityGroup(String((session.liveActivity as Record<string, unknown> | undefined)?.name ?? '')), seed)
      : statusCopy(status, seed)
  const description = getFirstString(
    session.lastAgentError ? (IS_ZH ? `失败：${String(session.lastAgentError)}` : `Failed: ${String(session.lastAgentError)}`) : undefined,
    taskCopy(session.task as string | undefined), // todo 任务文案：正在处理「xxx」
    getLiveActivity(), // 工具/思考活动详情（保留既有实用信息）
    fallbackCopy, // 档位状态文案（dsh-dafeiyu statusCopy）
    session.description,
    session.message,
    statusText,
  ) ?? (IS_ZH ? '会话' : 'Session')

  const variant = status === 'waiting' || status === 'review'
    ? 'warning'
    : status === 'failed' || status === 'error'
      ? 'danger'
      : status === 'success'
        ? 'success'
        : 'default'

  return {
    title,
    description,
    // 工作中平凡态显示 spinner（running/细分工作档位）；等待/终态档不显示 loading。
    isLoading: status === 'running' || status === 'thinking' || status === 'working' || status === 'result',
    variant,
  }
}

/**
 * 创建一台会话气泡状态机。
 *
 * @param onMotion 聚合档位变化时的回调（React 侧传 `setState`）
 */
export function createBubbleTracker(onMotion: (motion: Motion | undefined) => void): BubbleTracker {
  // 状态容器（随实例生灭；React 侧只在卸载时 dispose，StrictMode 双挂载可安全重复调用）
  const sessions = new Map<string, BubbleSession>()
  const toastKeys = new Map<string, string>()
  const hideTimers = new Map<string, number>()
  const previousStatus = new Map<string, Motion | undefined>()
  const failedUntil = new Map<string, number>()
  const pulseTimers = new Map<string, number>()
  const consumedFailed = new Set<string>()
  const dismissed = new Set<string>()
  const pruneTimers = new Map<string, number>()

  let lastAgg: Motion | undefined
  /** 合并窗口内最新计算出的聚合态（未下发前持续被更新，窗口到期统一下发）。 */
  let pendingAgg: Motion | undefined
  /** pendingAgg 是否有待下发的变更（区分「待下发 undefined 态」与「无变更」）。 */
  let hasPendingAgg = false
  let aggFlushTimer: number | undefined

  /** 合并窗口到期：把窗口内「最新」聚合态下发（中间态已丢弃，只发最终值）。 */
  const flushPendingAgg = () => {
    aggFlushTimer = undefined
    if (!hasPendingAgg)
      return
    hasPendingAgg = false
    const next = pendingAgg
    if (next !== lastAgg) {
      lastAgg = next
      onMotion(next)
    }
  }

  const updateAgg = () => {
    const next = statusOf(sessions, failedUntil, Date.now())
    if (next === lastAgg && !hasPendingAgg)
      return
    // 始终只处理「最新」的会话状态变更：突发（多会话交错或单会话档位连跳）内
    // 每次 updateAgg 都刷新 pendingAgg 并重置合并窗口（trailing 窗口），
    // lastAgg 保持已下发的值——窗口只收敛到最终聚合态再一次性下发，
    // 中间档位（thinking/result/working 交错）全部丢弃，避免逐个触发
    // app.tsx 的 pet.change 让动画被反复切回/重载（多会话频繁切回动画的根因）。
    hasPendingAgg = true
    pendingAgg = next
    if (aggFlushTimer !== undefined)
      window.clearTimeout(aggFlushTimer)
    aggFlushTimer = window.setTimeout(flushPendingAgg, STATUS_COALESCE_MS)
  }

  const clearTimer = (map: Map<string, number>, id: string) => {
    const timer = map.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      map.delete(id)
    }
  }

  const closeToast = (id: string) => {
    clearTimer(hideTimers, id)
    const key = toastKeys.get(id)
    if (key !== undefined) {
      toast.close(key)
      toastKeys.delete(id)
    }
  }

  /** 清除指定会话的所有关联缓存及定时器 */
  const removeSessionData = (id: string) => {
    sessions.delete(id)
    previousStatus.delete(id)
    dismissed.delete(id)
    failedUntil.delete(id)
    consumedFailed.delete(id)
    clearTimer(pulseTimers, id)
    clearTimer(hideTimers, id)
    clearTimer(pruneTimers, id)
    closeToast(id)
  }

  /** 沉淀清除：超过保留时间后彻底清理空闲会话 */
  const pruneSession = (id: string) => {
    const session = sessions.get(id)
    if (!session)
      return
    // 活跃档（think/work/result/waiting/running/review）不沉淀；
    // 终态档（workStatus success/error）翻开底层：底层空闲（回合完成且无错误残留）才可沉淀。
    const status = sessionStatus(session)
    const bottom = sessionStatus(session, true)
    if (bottom !== undefined)
      return
    if (status !== undefined && status !== 'success' && status !== 'error')
      return

    removeSessionData(id)
    updateAgg()
  }

  const armPrune = (id: string) => {
    clearTimer(pruneTimers, id)
    const timer = window.setTimeout(() => {
      pruneTimers.delete(id)
      pruneSession(id)
    }, IDLE_SESSION_RETENTION)
    pruneTimers.set(id, timer)
  }

  const scheduleHide = (id: string, current: Motion) => {
    clearTimer(hideTimers, id)
    const timeout = current === 'failed' || current === 'error'
      ? FAILED_BUBBLE_TIMEOUT
      : current === 'review'
        ? REVIEW_BUBBLE_TIMEOUT
        : current === 'success'
          ? SUCCESS_TOAST_TIMEOUT
          : undefined
    const key = toastKeys.get(id)
    if (timeout === undefined || key === undefined)
      return

    const timer = window.setTimeout(() => {
      if (toastKeys.get(id) === key) {
        dismissed.add(id)
        closeToast(id)
      }
    }, timeout)
    hideTimers.set(id, timer)
  }

  const trackFailedPulse = (session: BubbleSession) => {
    const current = sessionStatus(session)
    const previous = previousStatus.get(session.id)

    if (current === 'failed' || current === 'error' || current === 'success') {
      if (previous === current || consumedFailed.has(session.id))
        return

      // 终态档脉冲窗口：failed 短 TTL 恢复底层状态；success/error 为终态档，
      // 保持 TERMINAL_PULSE_TTL（对齐 dsh-pet 10s 收气泡），等动画完整播完再回落空闲。
      const ttl = current === 'success' || current === 'error' ? TERMINAL_PULSE_TTL : FAILED_PULSE_TTL
      const deadline = Date.now() + ttl
      failedUntil.set(session.id, deadline)
      clearTimer(pulseTimers, session.id)

      const timer = window.setTimeout(() => {
        if (failedUntil.get(session.id) !== deadline)
          return
        failedUntil.delete(session.id)
        clearTimer(pulseTimers, session.id)
        consumedFailed.add(session.id)
        updateAgg()
      }, ttl)

      pulseTimers.set(session.id, timer)
    }
    else {
      failedUntil.delete(session.id)
      clearTimer(pulseTimers, session.id)
      consumedFailed.delete(session.id)
    }
  }

  const syncToast = (session: BubbleSession) => {
    const current = sessionStatus(session)
    const previous = previousStatus.get(session.id)
    previousStatus.set(session.id, current)
    const key = toastKeys.get(session.id)

    // 子代理会话整体静默：状态仍参与聚合与沉淀（previousStatus/armPrune 照常），
    // 但不创建/更新/关闭任何 toast——子代理任务多且切换频繁，活跃追踪 toast 会
    // 不断弹出/更新，属于视觉噪音（此前只抑制了「已完成」toast，活跃 toast 仍会弹）。
    if (session.origin === 'subagent') {
      if (key !== undefined) {
        closeToast(session.id)
      }
      if (current === undefined && previous !== undefined) {
        armPrune(session.id)
      }
      return
    }

    if (current === undefined) {
      if (key !== undefined)
        closeToast(session.id)

      // 子代理静默关闭：不弹「已完成」成功 toast
      if (previous === 'running' && session.origin !== 'subagent') {
        toast(sessionTitle(session).trim(), {
          description: '已完成',
          placement: 'top end',
          variant: 'success',
          timeout: SUCCESS_TOAST_TIMEOUT,
        })
      }
      if (previous !== undefined)
        armPrune(session.id)
      return
    }

    clearTimer(pruneTimers, session.id)
    // 终态档（播完即收）：failed/error 失败、review 待审阅、success 完成。
    const isTerminal = current === 'failed' || current === 'review' || current === 'error' || current === 'success'
    if (!isTerminal) {
      dismissed.delete(session.id)
    }

    const content = toastContent(session, current)
    if (key === undefined) {
      if (dismissed.has(session.id) || previous === current)
        return

      let createdKey = ''
      createdKey = toast(content.title, {
        isLoading: content.isLoading,
        description: content.description,
        placement: 'top end',
        variant: content.variant as 'warning' | 'danger' | 'default' | 'success',
        timeout: 0,
        onClose: () => {
          if (toastKeys.get(session.id) === createdKey) {
            toastKeys.delete(session.id)
            clearTimer(hideTimers, session.id)
          }
        },
      })
      toastKeys.set(session.id, createdKey)
    }
    else {
      toast.update(key, content as ToastContentValue)
    }

    if (previous !== current && isTerminal) {
      scheduleHide(session.id, current)
    }
  }

  function apply(payload: unknown, action: SessionAction): void {
    const session = rawSession(payload)
    if (!session)
      return

    if (action === 'remove') {
      removeSessionData(session.id)
    }
    else {
      sessions.set(session.id, session)
      trackFailedPulse(session)
      syncToast(session)
    }

    updateAgg()
  }

  function dispose(): void {
    // 统一清理所有 Map 定时器与 Toast（幂等；StrictMode 的「挂载→释放→再挂载」下
    // 第二次释放是空操作，追踪器本身仍可继续接收事件）。
    const clearAllTimers = (map: Map<string, number>) => {
      map.forEach(timer => window.clearTimeout(timer))
      map.clear()
    }
    clearAllTimers(hideTimers)
    clearAllTimers(pulseTimers)
    clearAllTimers(pruneTimers)
    if (aggFlushTimer !== undefined) {
      window.clearTimeout(aggFlushTimer)
      aggFlushTimer = undefined
    }
    hasPendingAgg = false

    toastKeys.forEach(key => toast.close(key))
    toastKeys.clear()
  }

  return { apply, dispose }
}
