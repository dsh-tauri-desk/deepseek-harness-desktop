/**
 * components/width-handle.tsx — 内容宽度拖拽手柄（方案 A，镜像 alpha
 * dsh-client-ui-conversation 的私有 WidthHandle）。
 *
 * 对称手柄（左/右各一）：pointer capture + rAF 节流，双侧同时写入同一个居中
 * 宽度（外向拖拽 2× 指针位移）。pointermove 发布指针 Y 为 CSS 变量，让 hover
 * 发光条跟随。回调走 handle（service/width.ts），组件无业务状态之外的状态。
 */

import type { ReactElement } from 'react'
import type { PanelWidthHandleCallbacks } from '../service/width'
import { useCallback, useRef, useState } from 'react'
import { PANEL_CLASSES, PANEL_DATA_ATTRIBUTES, PANEL_WIDTH_VARS } from '../constants'

export interface WidthHandleProps {
  /** 手柄所在侧（决定外向拖拽方向）。 */
  side: 'left' | 'right'
  /** 宽度控制器回调（onStart/onDrag/onCommit/onEnd）。 */
  handle: PanelWidthHandleCallbacks
}

/** 自绘宽度手柄：pointer capture + rAF 节流的对称拖拽。 */
export function WidthHandle({ side, handle }: WidthHandleProps): ReactElement {
  const [dragging, setDragging] = useState(false)
  const baseRef = useRef(0)
  const originRef = useRef(0)
  const latestRef = useRef(0)
  const frameRef = useRef<number | null>(null)
  const callbacksRef = useRef(handle)
  callbacksRef.current = handle

  /** 外向拖拽宽度：base + 外向位移 × 2（双侧同时写同一居中宽度）。 */
  const outwardWidth = useCallback((): number => {
    const dx = latestRef.current - originRef.current
    const outward = side === 'right' ? dx : -dx
    return baseRef.current + outward * 2
  }, [side])

  const cancelFrame = useCallback((): void => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    originRef.current = event.clientX
    latestRef.current = event.clientX
    baseRef.current = callbacksRef.current.onStart()
    setDragging(true)
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty(PANEL_WIDTH_VARS.pointerY, `${event.clientY - box.top}px`)
    if (!event.currentTarget.hasPointerCapture(event.pointerId))
      return
    latestRef.current = event.clientX
    frameRef.current ??= requestAnimationFrame(() => {
      frameRef.current = null
      callbacksRef.current.onDrag(outwardWidth())
    })
  }, [outwardWidth])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId))
      return
    event.currentTarget.releasePointerCapture(event.pointerId)
    cancelFrame()
    latestRef.current = event.clientX
    if (latestRef.current !== originRef.current)
      callbacksRef.current.onCommit(outwardWidth())
    setDragging(false)
    callbacksRef.current.onEnd()
  }, [cancelFrame, outwardWidth])

  const onPointerCancel = useCallback((): void => {
    cancelFrame()
    setDragging(false)
    callbacksRef.current.onEnd()
  }, [cancelFrame])

  return (
    <div
      className={PANEL_CLASSES.widthHandle}
      data-side={side}
      {...{ [PANEL_DATA_ATTRIBUTES.widthHandle]: side }}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}
