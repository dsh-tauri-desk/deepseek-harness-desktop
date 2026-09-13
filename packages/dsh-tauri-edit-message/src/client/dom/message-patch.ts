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

import type { HostRowState, SessionsService } from '../types'
import { postEdit } from '../apis'
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
import { createPencilIcon } from './icons'
import { currentSessionId, getSessions, openWhenListed } from './runtime'

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
  const text = textarea.value.trim()
  if (sessionId === undefined || turn === undefined || text === '')
    return
  confirm.disabled = true
  error.hidden = true
  try {
    const plan = await postEdit({ sessionId, turn, text })
    if (!plan.ok)
      throw new Error(plan.message || plan.code)
    const sessions = getSessions()
    if (!sessions || typeof sessions.fork !== 'function')
      throw new Error('当前内核没有提供会话 fork 能力，无法撤回重建。')
    // 官方 fork 即截断边界器：child 进入会话列表、可打开、继承前缀历史。
    const childId = await sessions.fork({ sessionId, atSeq: plan.boundary })
    if (typeof childId !== 'string' || childId === '')
      throw new Error('会话 fork 没有返回新的会话 id。')
    await archiveOriginal(sessions, sessionId)
    // 先把改后的文本发进新会话（此时它已存在，只是可能还没出现在侧栏快照里）。
    await sendPrompt(childId, text)
    endEdit(row)
    openWhenListed(childId)
  }
  catch (e) {
    error.textContent = String((e as Error)?.message || e)
    error.hidden = false
  }
  finally {
    confirm.disabled = false
  }
}

/** 归档原会话（no-op 视为成功；失败只是外观问题，不让编辑失败）。 */
async function archiveOriginal(sessions: SessionsService, sessionId: string): Promise<void> {
  const workspaces = (sessions as { workspaces?: unknown }).workspaces
  const target = workspaces ?? sessions
  const archive = (target as { archiveSession?: (id: string) => unknown }).archiveSession
  if (typeof archive !== 'function')
    return
  try {
    await Promise.resolve(archive.call(target, sessionId))
  }
  catch {
    // 归档失败不影响已经建好的新分支。
  }
}

/**
 * 把文本发进目标会话。
 *
 * 走官方会话面 `ctx.sessions.binding(id).session.prompt(content)`；缺失时给出可诊断
 * 的错误，而不是静默半成品（新会话已建好，用户可手动把文本发一遍）。
 */
async function sendPrompt(sessionId: string, text: string): Promise<void> {
  const sessions = getSessions()
  const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
  const session = (binding as { session?: unknown } | undefined)?.session as {
    prompt?: (content: unknown, mode?: unknown) => Promise<unknown>
  } | undefined
  if (!session || typeof session.prompt !== 'function')
    throw new Error('新会话已建立，但当前内核不暴露 prompt 接口：请点开新会话后手动发送改后的文本。')
  await session.prompt([{ type: 'text', text }])
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
