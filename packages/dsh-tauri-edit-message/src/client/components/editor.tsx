/**
 * client/components/editor.tsx — 编辑面板（React 组件）。
 *
 * 与官方气泡同宽、圆角、灰底；`Enter` 提交、`Shift+Enter` 换行、`Esc` 取消。
 * 组件只管 UI 与本地状态，提交交给 `service/edit.ts`，因此失败提示也在这里呈现
 * （「谁执行，谁提示」：提示只有一个出处）。
 *
 * 样式仍由 css-render 的 `.dshp-edit-message__*` 类提供（`styles/editor.cssr.ts` 挂载），
 * 组件只引用类名，不写内联样式 —— 与仓库其余 UI 一致。
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { submitEdit } from '../service/edit'

/** 组件入参。 */
export interface EditorProps {
  /** 被编辑消息所在的会话。 */
  sessionId: string
  /** 该消息所在的轮次。 */
  turn: number
  /** 编辑初值（官方气泡的文本）。 */
  initialText: string
  /** 用户取消（Esc / 取消按钮）。 */
  onCancel: () => void
}

/**
 * 编辑面板。
 * @param props - 见 {@link EditorProps}。
 * @param props.sessionId - 被编辑消息所在的会话。
 * @param props.turn - 该消息所在的轮次。
 * @param props.initialText - 编辑初值（官方气泡的文本）。
 * @param props.onCancel - 用户取消（Esc / 取消按钮）。
 */
export function Editor({ sessionId, turn, initialText, onCancel }: EditorProps): ReactElement {
  const [text, setText] = useState(initialText)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // 进入即聚焦并把光标放到末尾（与手动点击编辑按钮的体感一致）。
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea)
      return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    const trimmed = text.trim()
    if (busy || trimmed === '')
      return
    setBusy(true)
    setError('')
    const outcome = await submitEdit(sessionId, turn, trimmed)
    if (outcome.ok) {
      onCancel()
      return
    }
    setError(outcome.message)
    setBusy(false)
  }, [busy, onCancel, sessionId, text, turn])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter 提交，Shift+Enter 换行（浏览器默认行为即换行）。
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }, [onCancel, submit])

  return (
    <div className="dshp-edit-message__editor">
      <textarea
        ref={textareaRef}
        className="dshp-edit-message__textarea"
        rows={3}
        aria-label="编辑消息"
        value={text}
        disabled={busy}
        onChange={event => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {error === '' ? null : <div className="dshp-edit-message__error">{error}</div>}
      <div className="dshp-edit-message__actions">
        <button type="button" className="dshp-edit-message__btn" onClick={onCancel}>取消</button>
        <button
          type="button"
          className="dshp-edit-message__btn dshp-edit-message__btn--primary"
          disabled={busy || text.trim() === ''}
          onClick={() => void submit()}
        >
          发送
        </button>
      </div>
    </div>
  )
}
