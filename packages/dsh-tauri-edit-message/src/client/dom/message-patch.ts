/**
 * client/dom/message-patch.ts — 用户气泡的 DOM 注入 + 撤回式编辑（对齐 DSH-EasyRewrite）。
 *
 * 行为对齐 docs/spec/EDIT_MESSAGE.md，执行方式对齐 DSH-EasyRewrite：
 *   - 悬停 / 停留用户气泡时，官方操作行里多出一个 Edit 图标按钮；
 *   - 点击后隐藏官方气泡，原位插入宽 100%、圆角、灰底的编辑面板；
 *   - `Enter` 提交、`Shift+Enter` 换行、`Esc` 取消；
 *   - 提交时：宿主只解析边界（该消息之前最后一个闭合回合的 turn/end），**客户端**用
 *     官方 `sessions.fork({ sessionId, atSeq: boundary })` 建新会话 → 归档原会话 →
 *     打开新会话 → 在新会话里把改后的文本发出去重新生成。
 *
 * 这样源会话全程不被重新激活（宿主半区不 resume agent、不 followup），所以不会出现
 * 「编辑一次，整段对话又被跑一遍」。
 *
 * 官方气泡本体不做任何替换：只隐藏（`display:none`，可逐字还原）并往里追加插件节点。
 */

import type { HostRowState } from '../types'
import { postArchive, postEdit } from '../apis'
import {
  CLS_ACTIONS,
  CLS_BUTTON,
  CLS_BUTTON_PRIMARY,
  CLS_EDIT_BTN,
  CLS_EDITOR,
  CLS_ERROR,
  CLS_OWN_ACTIONS,
  CLS_TEXTAREA,
  HOST_ACTIONS_CLASS,
  HOST_BUBBLE_CLASS,
  HOST_STACK_CLASS,
  INJECTED_ATTR,
  MARK_EDIT,
  MARK_EDITOR,
  MARK_OWN_ACTIONS,
  USER_ROW_SELECTOR,
  USER_TURN_ATTR,
} from '../constants'
import { logEvent } from './debug-log'
import { createPencilIcon } from './icons'
import { createFreshSession, currentSessionId, getSessions, openWhenListed, workspaceOf } from './runtime'

/** 行状态缓存（WeakMap，行被移除即回收）。 */
const rowStates = new WeakMap<Element, HostRowState>()

/** 取（或建）行状态。 */
function stateOf(row: Element): HostRowState {
  let state = rowStates.get(row)
  if (state === undefined) {
    state = { element: row, editing: false, bubbleDisplay: '' }
    rowStates.set(row, state)
  }
  return state
}

/** 轮次（`data-chat-turn`）。 */
function turnOf(row: Element): number | undefined {
  const raw = row.getAttribute(USER_TURN_ATTR)
  if (raw === null)
    return undefined
  const turn = Number(raw)
  return Number.isFinite(turn) ? turn : undefined
}

/** 官方操作行（可能不存在）。 */
function hostActions(row: Element): HTMLElement | null {
  return row.querySelector<HTMLElement>(`.${HOST_ACTIONS_CLASS}`)
}

/** 官方气泡。 */
function hostBubble(row: Element): HTMLElement | null {
  return row.querySelector<HTMLElement>(`.${HOST_BUBBLE_CLASS}`)
}

/** 官方气泡列（编辑面板插在这里）。 */
function hostStack(row: Element): HTMLElement | null {
  return row.querySelector<HTMLElement>(`.${HOST_STACK_CLASS}`)
}

/** 气泡正文（编辑初值取自官方气泡，不解析任何节点 payload）。 */
function bubbleText(row: Element): string {
  const bubble = hostBubble(row)
  return bubble ? (bubble.textContent ?? '') : ''
}

/* ------------------------------------------------------------ Edit 按钮 -- */

/** 造 Edit 图标按钮（复用官方 `.xzv4MW_action` 类，尺寸 / hover 同源）。 */
function createEditButton(row: Element): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `${HOST_ACTIONS_CLASS} ${CLS_EDIT_BTN}`
  button.setAttribute(INJECTED_ATTR, '')
  button.setAttribute('data-mtx-mark', MARK_EDIT)
  button.title = '编辑消息'
  button.setAttribute('aria-label', '编辑消息')
  button.appendChild(createPencilIcon())
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    beginEdit(row)
  })
  return button
}

/** 把 Edit 按钮追加进官方操作行；没有官方操作行时自建一条。 */
function ensureEditButton(row: Element): void {
  const actions = hostActions(row)
  if (actions) {
    if (!actions.querySelector(`[${INJECTED_ATTR}][data-mtx-mark="${MARK_EDIT}"]`))
      actions.appendChild(createEditButton(row))
    return
  }
  if (!hostStack(row))
    return
  if (row.querySelector<HTMLElement>(`[${INJECTED_ATTR}][data-mtx-mark="${MARK_OWN_ACTIONS}"]`))
    return
  const own = document.createElement('div')
  own.setAttribute(INJECTED_ATTR, '')
  own.setAttribute('data-mtx-mark', MARK_OWN_ACTIONS)
  own.className = CLS_OWN_ACTIONS
  own.appendChild(createEditButton(row))
  row.appendChild(own)
}

/* ---------------------------------------------------------------- 编辑 -- */

/** 现行编辑面板。 */
function editorOf(row: Element): HTMLElement | null {
  return row.querySelector<HTMLElement>(`[${INJECTED_ATTR}][data-mtx-mark="${MARK_EDITOR}"]`)
}

/** 进入编辑态：隐藏官方气泡与操作行，插入编辑面板。 */
function beginEdit(row: Element): void {
  const state = stateOf(row)
  if (state.editing)
    return
  const stack = hostStack(row)
  const bubble = hostBubble(row)
  if (!stack || !bubble)
    return
  state.editing = true
  state.bubbleDisplay = bubble.style.display
  bubble.style.display = 'none'
  const actions = hostActions(row)
  if (actions)
    actions.style.display = 'none'
  ensureEditor(row)
}

/** 退出编辑态：逐字还原官方气泡与操作行，移除面板。 */
function endEdit(row: Element): void {
  const state = stateOf(row)
  state.editing = false
  const bubble = hostBubble(row)
  if (bubble)
    bubble.style.display = state.bubbleDisplay
  const actions = hostActions(row)
  if (actions)
    actions.style.display = ''
  editorOf(row)?.remove()
}

/** 造编辑面板（多行输入框 + 右下角取消 / 发送）。 */
function ensureEditor(row: Element): void {
  if (editorOf(row))
    return
  const stack = hostStack(row)
  if (!stack)
    return

  const panel = document.createElement('div')
  panel.setAttribute(INJECTED_ATTR, '')
  panel.setAttribute('data-mtx-mark', MARK_EDITOR)
  panel.className = CLS_EDITOR

  const textarea = document.createElement('textarea')
  textarea.className = CLS_TEXTAREA
  textarea.value = bubbleText(row)
  textarea.rows = 3
  textarea.setAttribute('aria-label', '编辑消息')

  const error = document.createElement('div')
  error.className = CLS_ERROR
  error.hidden = true

  const actions = document.createElement('div')
  actions.className = CLS_ACTIONS

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = CLS_BUTTON
  cancel.textContent = '取消'
  cancel.addEventListener('click', (event) => {
    event.preventDefault()
    endEdit(row)
  })

  const confirm = document.createElement('button')
  confirm.type = 'button'
  confirm.className = CLS_BUTTON
  confirm.classList.add(CLS_BUTTON_PRIMARY)
  confirm.textContent = '发送'
  confirm.addEventListener('click', (event) => {
    event.preventDefault()
    void submitEdit(row, textarea, confirm, error)
  })

  actions.append(cancel, confirm)
  panel.append(textarea, error, actions)
  stack.appendChild(panel)
  textarea.focus()
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  textarea.addEventListener('keydown', (event) => {
    // Enter 提交，Shift+Enter 换行（浏览器默认行为即为换行）。
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitEdit(row, textarea, confirm, error)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      endEdit(row)
    }
  })
}

/** 提交编辑：宿主解析边界 → 官方 fork → 归档原会话 → 打开新会话 → 发送改后的文本。 */
async function submitEdit(
  row: Element,
  textarea: HTMLTextAreaElement,
  confirm: HTMLButtonElement,
  error: HTMLElement,
): Promise<void> {
  const sessionId = currentSessionId()
  const turn = turnOf(row)
  logEvent('submit', 'context', { sessionId: sessionId ?? null, turn: turn ?? null, currentFromList: currentSessionId() ?? null, rowTurn: row.getAttribute(USER_TURN_ATTR) })
  const text = textarea.value.trim()
  if (sessionId === undefined || turn === undefined || text === '')
    return
  confirm.disabled = true
  error.hidden = true
  logEvent('submit', 'begin', { sessionId, turn, textLength: text.length, text: text.slice(0, 40) })
  try {
    const plan = await postEdit({ sessionId, turn, text })
    logEvent('submit', 'plan', plan)
    if (!plan.ok)
      throw new Error(plan.message || plan.code)
    const sessions = getSessions()
    if (!sessions)
      throw new Error('当前内核没有提供会话服务，无法重建会话。')
    let childId: string
    if (plan.reset) {
      // 必须在归档/删除之前定位工作区：归档会把该会话从工作区名单里摘掉。
      const workspaceId = workspaceOf(sessions, sessionId)
      // 首轮：之前没有任何闭合回合可锚，fork 的最小切点必然把整轮复制过去。
      // 与 DSH-EasyRewrite 的 reset 分支一致——归档原会话 + 同工作区开空白新会话。
      await retireOriginal(sessionId)
      childId = await createFreshSession(sessions, workspaceId)
    }
    else {
      if (typeof sessions.fork !== 'function')
        throw new Error('当前内核没有提供会话 fork 能力，无法撤回重建。')
      // 官方 fork 即截断边界器：child 进入会话列表、可打开、继承前缀历史。
      logEvent('submit', 'fork-call', { sessionId, atSeq: plan.boundary })
      childId = await sessions.fork({ sessionId, atSeq: plan.boundary })
      if (typeof childId !== 'string' || childId === '')
        throw new Error('会话 fork 没有返回新的会话 id。')
      // 核对 fork 是否真的按 atSeq 截断：把子会话的回合表记下来。
      // 若这里出现 turn > plan.turn，说明运行中的内核忽略了 atSeq（或用了兜底 findLast），
      // 那就是「编辑后旧消息还在、看起来又跑一遍」的直接证据。
      logEvent('submit', 'fork-verify', await describeSession(sessions, childId, plan.turn))
      // 新会话建成后才动原会话：fork 已经拿到前缀历史，删除不会丢内容。
      await retireOriginal(sessionId)
    }
    logEvent('submit', plan.reset ? 'created' : 'forked', { childId, boundary: plan.boundary, reset: plan.reset })
    // 先打开新会话：官方 composer 的动作面要等该会话进入舞台（scope 物化）才可用，
    // DSH-EasyRewrite 也是「先 openSession(newId) → 等 composer 就绪 → setDraft + submit」。
    endEdit(row)
    openWhenListed(childId)
    // 把改后的文本发进新会话（此时它已存在，只是可能还没出现在侧栏快照里）。
    await sendPrompt(childId, text)
    logEvent('submit', 'prompted', { childId })
  }
  catch (e) {
    logEvent('submit', 'failed', { error: String((e as Error)?.message || e) })
    error.textContent = String((e as Error)?.message || e)
    error.hidden = false
  }
  finally {
    confirm.disabled = false
  }
}

/**
 * 处理被取代的原会话：**归档**（官方可逆操作，与 DSH-EasyRewrite 一致）。
 *
 * 暂时不做物理删除：`/api/dsh-session/delete` 会移除 fork 父会话的数据目录，
 * 而子会话的 seed 血缘指向它——这是本实现相对两个参考插件**独有**的副作用
 * （REF B 只 archive，REF A 连 archive 都不做）。先用最保守的归档验证
 * 「旧轮不再重跑」；确认稳定后若仍要物理删除，再单独打开。
 *
 * 归档失败只记警告：编辑已经成功，新会话可用，不让它失败。
 */
async function retireOriginal(sessionId: string): Promise<void> {
  try {
    await postArchive(sessionId)
    logEvent('submit', 'archived', { sessionId })
  }
  catch (e) {
    logEvent('submit', 'archive-failed', { sessionId, error: String((e as Error)?.message || e) })
    console.warn('[dsh-tauri-edit-message] 原会话归档失败（编辑已生效）。', e)
  }
}

/**
 * 把文本发进目标会话——走**官方 composer 的公开动作面**（与 DSH-EasyRewrite 一致）。
 *
 * DSH-EasyRewrite 从不调用 `session.prompt`：它在 `conversation.input.dock` 槽里取到
 * 官方 input 门面的 actions，然后用 `setDraft(text)` + `submit()` 让**应用自己的发送
 * 路径**提交（`submit()` 内部就是 `this.submit("queue")`）。这条路径会经过编辑器的
 * draft 状态、提交机与本地回显，因此行为与应用里手动发送完全一致。
 *
 * 0.1.2 起宿主不再下发 `inputActions`，改为经会话 scope 自取：
 * `ctx.sessions.scope(id).get('conversation').input.for(scope).actions`。
 * 取不到时回落到 `session.prompt(content, 'queue')`（RPC 直发），再不行给出可诊断错误。
 */
async function sendPrompt(sessionId: string, text: string): Promise<void> {
  const sessions = getSessions()
  const actions = composerActions(sessions, sessionId)
  logEvent('submit', 'composer', {
    sessionId,
    hasScope: typeof (sessions as { scope?: unknown } | null)?.scope === 'function',
    hasSetDraft: typeof actions?.setDraft === 'function',
    hasSubmit: typeof actions?.submit === 'function',
  })
  if (actions && typeof actions.setDraft === 'function' && typeof actions.submit === 'function') {
    const { setDraft, submit } = actions as { setDraft: (text: string) => void, submit: () => void }
    setDraft(text)
    // 与 EasyRewrite 一致：提交前留一点时间让编辑器的 draft 状态落定（它用 60ms）。
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60)
    })
    submit()
    return
  }

  const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
  const session = (binding as { session?: unknown } | undefined)?.session as {
    prompt?: (content: unknown, mode: unknown) => Promise<unknown>
  } | undefined
  if (!session || typeof session.prompt !== 'function')
    throw new Error('新会话已建立，但当前内核既不暴露 composer 动作面也没有 prompt 接口：请点开新会话后手动发送改后的文本。')
  // mode 是 session/prompt 的必填枚举（"queue" | "steer"）：漏传会被 schema 拒绝
  // （client api: session/prompt rejected "request"）。这里要的是正常排队一轮，用 queue。
  await session.prompt([{ type: 'text', text }], 'queue')
}

/**
 * 摘要一条会话的回合表（诊断用：核对 fork 是否真按 atSeq 截断）。
 *
 * 直接读会话日志（`snapshotEvents()`），列出每个 `turn/start` 的 seq 与紧随其后的
 * 用户文本，因此「子会话里是否残留被编辑掉的那一轮」一眼可见。
 */
async function describeSession(
  sessions: NonNullable<ReturnType<typeof getSessions>>,
  sessionId: string,
  targetTurn: number,
): Promise<Record<string, unknown>> {
  try {
    const binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
    const session = (binding as { session?: unknown } | undefined)?.session as {
      snapshotEvents?: () => Array<{ seq: number, type: string, data?: Record<string, unknown> }>
    } | undefined
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
    if (!Array.isArray(events))
      return { sessionId, unavailable: true }
    const turns: Array<{ turn: unknown, startSeq: number, userSeq: number | null, text: string }> = []
    let current: { turn: unknown, startSeq: number, userSeq: number | null, text: string } | undefined
    for (const event of events) {
      if (event.type === 'turn/start') {
        if (current)
          turns.push(current)
        current = { turn: event.data?.turn, startSeq: event.seq, userSeq: null, text: '' }
        continue
      }
      if (current && event.type === 'user/message' && current.userSeq === null) {
        const blocks = event.data?.content
        if (Array.isArray(blocks)) {
          current.userSeq = event.seq
          current.text = blocks.map(block => String((block as { text?: string }).text ?? '')).join('').slice(0, 24)
        }
      }
    }
    if (current)
      turns.push(current)
    return {
      sessionId,
      targetTurn,
      eventCount: events.length,
      turns,
      // fork 若忽略了 atSeq，子会话里就会留下 targetTurn 及之后的轮次。
      keptBeyondTarget: turns.filter(t => typeof t.turn === 'number' && (t.turn as number) >= targetTurn).map(t => t.turn),
    }
  }
  catch (e) {
    return { sessionId, error: String((e as Error)?.message || e) }
  }
}

/** 官方 composer 的动作面（`setDraft` / `submit` / `addAttachments`）。 */interface ComposerActions {
  setDraft?: (text: string) => void
  submit?: () => void
}

/**
 * 经会话 scope 取官方 input 门面的 actions。
 *
 * 全程防御式：任一环节缺失都返回 undefined，由调用方决定回落。
 */
function composerActions(sessions: ReturnType<typeof getSessions>, sessionId: string): ComposerActions | undefined {
  try {
    const scope = (sessions as { scope?: (id: string) => unknown } | null)?.scope
    if (typeof scope !== 'function' || sessions === null)
      return undefined
    const sessionScope = scope.call(sessions, sessionId) as { get?: (name: string) => unknown } | undefined
    const conversation = sessionScope?.get?.('conversation') as {
      input?: { for?: (scope: unknown) => { actions?: ComposerActions } }
    } | undefined
    const shell = conversation?.input?.for?.(sessionScope)
    return shell?.actions
  }
  catch {
    return undefined
  }
}

/* ---------------------------------------------------------------- 安装 -- */

/** 对单个用户行补齐注入（幂等）。 */
function patchRow(row: Element): void {
  // 编辑态下 React 若重建了操作行，不打扰正在编辑的面板。
  if (stateOf(row).editing)
    return
  ensureEditButton(row)
}

/** 对一棵子树补齐注入（跳过插件自己的节点）。 */
export function patchSubtree(root: ParentNode): number {
  const candidates: Element[] = []
  if (root instanceof Element && root.matches(USER_ROW_SELECTOR))
    candidates.push(root)
  root.querySelectorAll(USER_ROW_SELECTOR).forEach((node) => {
    if (!(node as Element).hasAttribute(INJECTED_ATTR))
      candidates.push(node)
  })
  for (const row of candidates)
    patchRow(row)
  return candidates.length
}
