import type { PointerEvent as ReactPointerEvent } from 'react'
import { useState } from 'react'
import { RAIL_WIDTH_DEFAULT } from '../constants'
import { clampRailWidth, setRailWidth, useSettingsUi } from '../store'

/**
 * hooks/use-rail-drag.ts — 左栏宽度拖拽交互（pointer capture + rAF 节流）。
 *
 * 从 sidebar.tsx 拆出的独立交互钩子：拖拽句柄按 pointermove 实时写共享 store
 * 的 railWidth（调用方已按合约钳制），指针释放后结束拖拽。返回的 dragging 用于
 * 句柄的按压态样式（.dsh-tu-settingsHandleDragging）。
 */
export interface RailDragState {
  /** 拖拽进行中（句柄按压态）。 */
  dragging: boolean
  /** 绑定到分隔句柄的 onPointerDown（镜像官方 DragHandle 交互）。 */
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void
}

/** 左栏宽度拖拽钩子（railWidth 合约 clamp 见 store.clampRailWidth）。 */
export function useRailDrag(): RailDragState {
  const ui = useSettingsUi()
  const [dragging, setDragging] = useState(false)

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = ui.railWidth ?? RAIL_WIDTH_DEFAULT
    setDragging(true)
    let raf = 0
    const onMove = (moveEvent: PointerEvent): void => {
      if (raf)
        cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        setRailWidth(clampRailWidth(startWidth + (moveEvent.clientX - startX)))
      })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return { dragging, onHandlePointerDown }
}
