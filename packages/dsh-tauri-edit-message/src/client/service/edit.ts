/**
 * client/service/edit.ts — 一次编辑提交的业务编排。
 *
 * 从 DOM 注入层（`dom/message-patch.ts`）里抽出来，让 React 组件只负责 UI、
 * 只调用一个 `submitEdit(...)`：宿主建会话 → 收掉旧会话 → 导航新会话 → 发送改后文本。
 */

import type { SessionsService } from '../types'
import { postArchive, postDelete, postEdit } from '../apis'
import { logEvent } from '../dom/debug-log'
import { getSessions, openWhenListed } from '../dom/runtime'

/** 提交结果。失败时 `message` 为可展示文本。 */
export type EditOutcome = { ok: true, childId: string } | { ok: false, message: string }

/**
 * 提交一次消息编辑。
 *
 * @param sessionId 被编辑消息所在的会话
 * @param turn 该消息所在的轮次
 * @param text 改后的文本（非空，调用方已 trim）
 */
export async function submitEdit(sessionId: string, turn: number, text: string): Promise<EditOutcome> {
  logEvent('submit', 'begin', { sessionId, turn, textLength: text.length, text: text.slice(0, 40) })
  try {
    // 一次请求完成：宿主解析边界、建好截断子会话、并把继承来的悬挂 inbox 入队项排空。
    //
    // 为什么不由客户端 `sessions.fork({ atSeq })` 建：它的切点落在目标轮 `turn/start`，而
    // 提问的内核形态是「先 `agent/inbox/spliced` 入队 → `turn/start` → 之后才排空」。切在
    // `turn/start` 时，目标轮的入队事件在 seed 里、排空事件不在，子会话的 inbox 由日志重建
    // （dsh-agent-loop inboxProjectionDefinition：`inbox.toSpliced(start, removedCount, ...inserted)`），
    // 于是被丢弃的旧提问会复活成子会话的一轮（官方 fork 与 DSH-EasyRewrite 在 0.1.5-rc.2 同样复现）。
    const applied = await postEdit({ sessionId, turn, text })
    logEvent('submit', 'applied', applied)
    if (!applied.ok)
      throw new Error(applied.message || applied.code)
    const childId = applied.childId
    if (typeof childId !== 'string' || childId === '')
      throw new Error('宿主没有返回重建后的会话 id。')
    // 新会话已建好（seed 已经拷走前缀），收掉被取代的原会话：归档 → 物理删除。
    await retireOriginal(sessionId)
    // 先打开新会话：官方 composer 的动作面要等该会话进入舞台（scope 物化）才可用，
    // DSH-EasyRewrite 也是「先 openSession(newId) → 等 composer 就绪 → setDraft + submit」。
    openWhenListed(childId)
    // 把改后的文本发进新会话（此时它已存在，只是可能还没出现在侧栏快照里）。
    await sendPrompt(childId, text)
    logEvent('submit', 'prompted', { childId })
    return { ok: true, childId }
  }
  catch (e) {
    const message = String((e as Error)?.message || e)
    logEvent('submit', 'failed', { error: message })
    return { ok: false, message }
  }
}

/**
 * 收掉被取代的原会话：**归档**（官方可逆）→ **物理删除**（会话数据一并移除）。
 *
 * 两步都走内置插件 dsh-tauri-session 的官方路由；它的删除接口内建「必须是归档成员」
 * 校验，所以顺序不能反。两者都不允许让编辑失败（新会话已经建好并可用）：
 *   - 归档失败：原会话留在列表里，只记警告；
 *   - 删除失败：原会话仍安全地待在归档里，可由用户手动清理。
 */
async function retireOriginal(sessionId: string): Promise<void> {
  try {
    await postArchive(sessionId)
    logEvent('submit', 'archived', { sessionId })
  }
  catch (e) {
    logEvent('submit', 'archive-failed', { sessionId, error: String((e as Error)?.message || e) })
    console.warn('[dsh-tauri-edit-message] 原会话归档失败（编辑已生效）。', e)
    return
  }
  try {
    await postDelete(sessionId)
    logEvent('submit', 'deleted', { sessionId })
  }
  catch (e) {
    logEvent('submit', 'delete-failed', { sessionId, error: String((e as Error)?.message || e) })
    console.warn('[dsh-tauri-edit-message] 原会话彻底删除失败，已保留在归档中。', e)
  }
}

/** 官方 composer 的动作面（`setDraft` / `submit`）。 */
interface ComposerActions {
  setDraft?: (text: string) => void
  submit?: () => void
}

/**
 * 把文本发进目标会话——走**官方 composer 的公开动作面**（与 DSH-EasyRewrite 一致）。
 *
 * DSH-EasyRewrite 从不调用 `session.prompt`：它取官方 input 门面的 actions，然后用
 * `setDraft(text)` + `submit()` 让**应用自己的发送路径**提交（`submit()` 内部就是
 * `submit("queue")`）。这条路径会经过编辑器的 draft 状态、提交机与本地回显。
 *
 * 0.1.2 起宿主不再下发 `inputActions`，改为经会话 scope 自取：
 * `ctx.sessions.scope(id).get('conversation').input.for(scope).actions`。
 * 取不到时回落到 `session.prompt(content, 'queue')`，再不行给出可诊断错误。
 */
async function sendPrompt(sessionId: string, text: string): Promise<void> {
  const sessions = getSessions()
  const actions = composerActions(sessions, sessionId)
  logEvent('submit', 'composer', {
    sessionId,
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
  // mode 是 session/prompt 的必填枚举（"queue" | "steer"）：漏传会被 schema 拒绝。
  await session.prompt([{ type: 'text', text }], 'queue')
}

/** 经会话 scope 取官方 input 门面的 actions（全程防御式，任一环缺失都返回 undefined）。 */
function composerActions(sessions: SessionsService | null, sessionId: string): ComposerActions | undefined {
  try {
    const scope = (sessions as { scope?: (id: string) => unknown } | null)?.scope
    if (typeof scope !== 'function' || sessions === null)
      return undefined
    const sessionScope = scope.call(sessions, sessionId) as { get?: (name: string) => unknown } | undefined
    const conversation = sessionScope?.get?.('conversation') as {
      input?: { for?: (scope: unknown) => { actions?: ComposerActions } }
    } | undefined
    return conversation?.input?.for?.(sessionScope)?.actions
  }
  catch {
    return undefined
  }
}
