import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef } from 'react'

/** 官方会话根写入的拖拽宽度偏好键（`dsh-client-ui-conversation`）。 */
const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'
/** 官方内容宽下限；偏好值不得低于它。 */
const CONTENT_MIN = 640
/** 官方内容宽两侧留白预算：列宽减去它才是偏好上限。 */
const CONTENT_EDGE_BUDGET = 176

function readWidthPreference(): number | null {
  if (typeof localStorage === 'undefined')
    return null
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null)
    return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** 官方公式：有偏好时夹到 `[CONTENT_MIN, 列宽 - CONTENT_EDGE_BUDGET]`，否则自适应列宽的 64%。 */
function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
  if (preference !== null)
    return Math.min(Math.max(preference, CONTENT_MIN), max)
  return Math.max(680, Math.min(columnWidth * 0.64, 920))
}

/**
 * 面板宽度同步容器：让面板内容列与会话内容列逐像素对齐。
 *
 * 面板与会话根都是 `main` 槽的同级占位者，读不到会话根以行内样式发布的
 * `--dsh-conversation-column-width` 与 `--dsh-chat-user-width`（用户拖拽偏好）。
 * 只靠 `panelContainer` 的 `clamp(680px, 64%, 920px)` 会丢掉偏好那一层而与会话列错位，
 * 因此这里用与官方相同的公式在自身上发布同一组变量，再交给 `panelContainer` 消费。
 * 自身必须是未加 `max-width` 的满宽容器，否则测到的是收敛后的内容宽而非列宽。
 */
export function PanelWidthSync({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = ref.current
    if (element === null)
      return
    const publish = (): void => {
      const column = element.offsetWidth
      element.style.setProperty('--dsh-conversation-column-width', `${column}px`)
      const preference = readWidthPreference()
      if (preference === null)
        element.style.removeProperty('--dsh-chat-user-width')
      else
        element.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
    }
    publish()
    if (typeof ResizeObserver === 'undefined')
      return
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const style = {
    'width': '100%',
    '--dsh-chat-content-width': 'var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * .64), 920px))',
  } as CSSProperties

  return <div ref={ref} style={style}>{children}</div>
}
