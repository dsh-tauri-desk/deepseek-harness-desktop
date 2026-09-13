/**
 * client/dom/message-patch.tsx — 用户气泡的 DOM 注入层。
 *
 * 职责只有两件，业务编排在 `service/edit.ts`、UI 在 `components/editor.tsx`：
 *   1. 给官方用户气泡挂「编辑」入口（悬停操作行里的 Edit 图标按钮 + 双击气泡本体）；
 *   2. 进入编辑态时隐藏官方气泡与操作行，并在原位挂载 React 编辑面板（`createRoot`）。
 *
 * 官方气泡本体不做任何替换：只隐藏（`display:none`，可逐字还原）并往里追加插件节点。
 *
 * 类名约定：样式由 `styles/editor.cssr.ts` 的 `bem` 助手生成，其嵌套形态是**后代**选择器
 * （`.dshp-edit-message .dshp-edit-message__edit-btn`），所以每个注入节点的外层必须带块类
 * `BLOCK` —— 否则 Edit 按钮会退回浏览器默认样式（它被追加进的是**官方**操作行）。
 */

import type { HostRowState } from '../types'
import { Icon, Pencil } from 'dsh-tauri-ui/client'
import { createRoot } from 'react-dom/client'
import { Editor } from '../components/editor'
import {
  BLOCK,
  CLS_EDIT_BTN,
  DOUBLECLICK_ATTR,
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
import { currentSessionId } from './runtime'

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

/* ---------------------------------------------------------- 编辑入口 -- */

/** 挂双击监听：只认左键，并阻止双击选中文本。 */
function handleBubbleDoubleClick(row: Element, event: MouseEvent): void {
  if (event.button !== 0)
    return
  event.preventDefault()
  event.stopPropagation()
  beginEdit(row)
}

/**
 * 在官方气泡上装双击监听（幂等）。
 *
 * React 重建气泡时会换成新元素，所以按「当前气泡元素」逐个标记，由 `patchRow`
 * 在每次扫描时补齐。
 */
function ensureBubbleDoubleClick(row: Element): void {
  const bubble = hostBubble(row)
  if (!bubble || bubble.hasAttribute(DOUBLECLICK_ATTR))
    return
  bubble.setAttribute(DOUBLECLICK_ATTR, '')
  bubble.addEventListener('dblclick', event => handleBubbleDoubleClick(row, event))
}

/**
 * 造 Edit 图标按钮。
 *
 * 外面包一层带块类的容器：bem 的嵌套选择器需要一个块祖先，而按钮本体必须追加进
 * **官方**操作行（`.xzv4MW_action` 的尺寸 / hover 由官方负责）。
 */
function createEditButton(row: Element): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.setAttribute(INJECTED_ATTR, '')
  wrapper.setAttribute('data-mtx-mark', MARK_EDIT)
  wrapper.className = BLOCK

  const button = document.createElement('button')
  button.type = 'button'
  button.className = `${HOST_ACTIONS_CLASS} ${CLS_EDIT_BTN}`
  button.setAttribute(INJECTED_ATTR, '')
  button.title = '编辑消息'
  button.setAttribute('aria-label', '编辑消息')
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    beginEdit(row)
  })
  // 图标走共享的 `Icon` + Gravity `Pencil`（React 渲染；原生按钮不属于 React 树，
  // 因此用 createRoot 挂进去）。
  createRoot(button).render(<Icon as={Pencil} />)

  wrapper.appendChild(button)
  return wrapper
}

/** 把 Edit 按钮追加进官方操作行；没有官方操作行时自建一条。 */
function ensureEditButton(row: Element): void {
  const actions = hostActions(row)
  if (actions) {
    if (!actions.querySelector(`[${INJECTED_ATTR}][data-mtx-mark="${MARK_EDIT}"]`))
      actions.appendChild(createEditButton(row))
    return
  }
  if (!hostStack(row) || row.querySelector<HTMLElement>(`[${INJECTED_ATTR}][data-mtx-mark="${MARK_OWN_ACTIONS}"]`))
    return
  const own = document.createElement('div')
  own.setAttribute(INJECTED_ATTR, '')
  own.setAttribute('data-mtx-mark', MARK_OWN_ACTIONS)
  own.className = BLOCK
  own.appendChild(createEditButton(row))
  row.appendChild(own)
}

/* ---------------------------------------------------------------- 编辑 -- */

/** 现行编辑面板容器。 */
function editorOf(row: Element): HTMLElement | null {
  return row.querySelector<HTMLElement>(`[${INJECTED_ATTR}][data-mtx-mark="${MARK_EDITOR}"]`)
}

/** 进入编辑态：隐藏官方气泡与操作行，原位挂载 React 编辑面板。 */
function beginEdit(row: Element): void {
  const state = stateOf(row)
  if (state.editing)
    return
  const stack = hostStack(row)
  const bubble = hostBubble(row)
  const sessionId = currentSessionId()
  const turn = turnOf(row)
  if (!stack || !bubble || sessionId === undefined || turn === undefined)
    return

  state.editing = true
  state.bubbleDisplay = bubble.style.display
  bubble.style.display = 'none'
  const actions = hostActions(row)
  if (actions)
    actions.style.display = 'none'

  // 容器带块类，面板内部的 `__editor` / `__textarea` 等元素选择器才会命中
  // （bem 嵌套生成的是后代选择器）。
  const container = document.createElement('div')
  container.setAttribute(INJECTED_ATTR, '')
  container.setAttribute('data-mtx-mark', MARK_EDITOR)
  container.className = BLOCK
  container.style.width = '100%'
  stack.appendChild(container)
  state.root = createRoot(container)
  state.root.render(
    <Editor
      sessionId={sessionId}
      turn={turn}
      initialText={bubbleText(row)}
      onCancel={() => endEdit(row)}
    />,
  )
}

/** 退出编辑态：卸载 React 面板，逐字还原官方气泡与操作行。 */
function endEdit(row: Element): void {
  const state = stateOf(row)
  state.editing = false
  const root = state.root
  state.root = undefined
  // 先卸载再移除容器：让组件走完 unmount 生命周期（无订阅，但保持语义正确）。
  root?.unmount()
  editorOf(row)?.remove()
  const bubble = hostBubble(row)
  if (bubble)
    bubble.style.display = state.bubbleDisplay
  const actions = hostActions(row)
  if (actions)
    actions.style.display = ''
}

/* ---------------------------------------------------------------- 安装 -- */

/** 对单个用户行补齐注入（幂等）。 */
function patchRow(row: Element): void {
  // 编辑态下 React 若重建了官方节点，不打扰正在编辑的面板。
  if (stateOf(row).editing)
    return
  ensureBubbleDoubleClick(row)
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
