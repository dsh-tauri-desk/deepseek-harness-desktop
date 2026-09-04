import type { RefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect } from 'react'

interface DeviceMousePosition {
  x: number
  y: number
}

/**
 * 根据元素的真实屏幕位置自动切换桌宠窗口的点击穿透。
 *
 * 穿透后 WebView 不再收到 mouseenter/mouseleave，因此通过 Rust 端 rdev
 * 全局鼠标流获取设备像素坐标，再与元素的 DOMRect 命中区比较。调用方只需
 * 传入可交互元素的 ref，不需要管理启动监听、窗口移动、缩放或穿透状态。
 */
export function useOmitIgnoreCursorEvents(elementRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const appWindow = getCurrentWindow()
    let disposed = false
    let isIgnored = true
    let windowPosition: { x: number, y: number } | undefined
    let geometryRevision = 0
    let unlistenMouseMove: (() => void) | undefined
    let unlistenMoved: (() => void) | undefined
    let unlistenResized: (() => void) | undefined

    function setIgnoreCursorEvents(ignore: boolean): void {
      if (ignore === isIgnored)
        return
      isIgnored = ignore
      void appWindow.setIgnoreCursorEvents(ignore).catch(() => {})
    }

    async function refreshWindowPosition(): Promise<void> {
      const revision = ++geometryRevision
      const position = await appWindow.innerPosition()
      if (!disposed && revision === geometryRevision)
        windowPosition = position
    }

    function isCursorInElement(x: number, y: number): boolean | undefined {
      const element = elementRef.current
      if (element === null || windowPosition === undefined)
        return undefined

      const rect = element.getBoundingClientRect()
      const scale = globalThis.devicePixelRatio || 1
      const left = windowPosition.x + rect.left * scale
      const top = windowPosition.y + rect.top * scale
      const width = rect.width * scale
      const height = rect.height * scale
      return x >= left && x <= left + width && y >= top && y <= top + height
    }

    // 初始整窗穿透；穿透态下交互恢复完全由全局鼠标流驱动。
    void appWindow.setIgnoreCursorEvents(true).catch(() => {})
    void invoke('start_pet_mouse_stream').catch(() => {})
    void refreshWindowPosition()

    const movedPromise = appWindow.onMoved(() => {
      void refreshWindowPosition()
    })
    const resizedPromise = appWindow.onResized(() => {
      void refreshWindowPosition()
    })
    const mouseMovePromise = listen<DeviceMousePosition>('device-mouse-move', ({ payload }) => {
      const inElement = isCursorInElement(payload.x, payload.y)
      if (inElement !== undefined)
        setIgnoreCursorEvents(!inElement)
    })

    void Promise.all([movedPromise, resizedPromise, mouseMovePromise]).then(([moved, resized, mouseMove]) => {
      if (disposed) {
        moved()
        resized()
        mouseMove()
      }
      else {
        unlistenMoved = moved
        unlistenResized = resized
        unlistenMouseMove = mouseMove
      }
    }).catch(() => {})

    return () => {
      disposed = true
      geometryRevision++
      unlistenMoved?.()
      unlistenResized?.()
      unlistenMouseMove?.()
    }
  }, [elementRef])
}
