import type { RefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect } from 'react'

interface DeviceMousePosition {
  x: number
  y: number
}

/** `pet://status` 事件载荷（Rust PetStatus，snake_case 字段）。 */
interface RustPetStatus {
  enabled?: boolean
  visible?: boolean | null
}

/**
 * 根据元素的真实屏幕位置自动切换桌宠窗口的点击穿透。
 *
 * 穿透后 WebView 不再收到 mouseenter/mouseleave，因此通过 Rust 端 rdev
 * 全局鼠标流获取设备像素坐标，再与元素的 DOMRect 命中区比较。调用方只需
 * 传入可交互元素的 ref，不需要管理启动监听、窗口移动、缩放或穿透状态。
 *
 * # 兼容性（issue #394、#437）
 *
 * 穿透切换一律经由 Rust 命令 `set_pet_ignore_cursor_events` 而非直接调用
 * `setIgnoreCursorEvents`：Linux / Wayland 下 tao 处理 `CursorIgnoreEvents(true)`
 * 时对底层 GdkWindow 直接 `unwrap()`（tao 0.35.3 event_loop.rs:457，上游截至
 * 0.37.0 未修复），窗口从未显示（未 realize）即 panic 崩掉整个桌面端（issue #437）。
 * Rust 侧对不可见窗口吞掉 `true` 请求；前端再叠加一层：跟踪窗口可见性
 * （`pet://status`），窗口隐藏时直接跳过穿透请求，避免无效 IPC。
 *
 * 桌宠窗口只在「显示宠物」期间存在（收起即销毁，见 issue #469，本 hook 随页面
 * 一起重挂载），因此启动时不再存在「永久隐藏窗口也会请求穿透」的路径。
 *
 * issue #394 的「延后到首个 device-mouse-move 再应用」仍然保留：避免挂载时
 * 立刻与事件循环竞争，但真正防止 panic 的是上面的两层可见性保护。
 */
export function useOmitIgnoreCursorEvents(elementRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const appWindow = getCurrentWindow()
    let disposed = false
    // 初始为 false 以对齐真实 OS 状态（窗口创建后默认不穿透）：我们不再在挂载
    // 时急切开启穿透（见函数上方的 #394 说明），穿透态由首个 device-mouse-move
    // 事件按命中区计算后应用。
    let isIgnored = false
    // 窗口可见性未知（undefined）时放行请求，由 Rust 命令兜底；确认隐藏后跳过。
    let windowVisible: boolean | undefined
    // 递增的穿透请求序号：丢弃失序响应，防止旧请求的「实际生效态」覆盖新状态。
    let ignoreRequestRevision = 0
    let windowPosition: { x: number, y: number } | undefined
    let geometryRevision = 0
    let unlistenMouseMove: (() => void) | undefined
    let unlistenMoved: (() => void) | undefined
    let unlistenResized: (() => void) | undefined
    let unlistenStatus: (() => void) | undefined

    function setIgnoreCursorEvents(ignore: boolean): void {
      if (ignore === isIgnored)
        return
      if (ignore && windowVisible === false)
        return
      const revision = ++ignoreRequestRevision
      isIgnored = ignore
      void invoke<boolean>('set_pet_ignore_cursor_events', { ignore }).then((applied) => {
        if (!disposed && revision === ignoreRequestRevision)
          isIgnored = applied
      }).catch(() => {})
    }

    function handleVisibility(visible: boolean): void {
      windowVisible = visible
      if (visible)
        return
      // 窗口隐藏后穿透无意义：复位本地状态并同步关闭穿透（false 分支在
      // Rust 侧始终安全转发），保证重新显示后由鼠标事件重新计算并应用，
      // 也避免复用窗口时残留空输入区导致无法点击。
      isIgnored = false
      const revision = ++ignoreRequestRevision
      void invoke<boolean>('set_pet_ignore_cursor_events', { ignore: false }).then((applied) => {
        if (!disposed && revision === ignoreRequestRevision)
          isIgnored = applied
      }).catch(() => {})
    }

    async function refreshWindowPosition(): Promise<void> {
      const revision = ++geometryRevision
      const position = await appWindow.innerPosition()
      if (!disposed && revision === geometryRevision)
        windowPosition = position
    }

    function isCursorInElement(x: number, y: number): boolean | undefined {
      const element = elementRef.current
      // 未选择宠物（或渲染层尚未挂载）时没有可交互面：整窗穿透，避免一个空的
      // 透明置顶窗口吞掉桌面点击。
      if (element === null)
        return false
      if (windowPosition === undefined)
        return undefined

      const rect = element.getBoundingClientRect()
      const scale = globalThis.devicePixelRatio || 1
      const left = windowPosition.x + rect.left * scale
      const top = windowPosition.y + rect.top * scale
      const width = rect.width * scale
      const height = rect.height * scale
      return x >= left && x <= left + width && y >= top && y <= top + height
    }

    // 初始整窗穿透延后应用（见上方 #394 说明）：这里只启动鼠标流、可见性与窗口
    // 几何追踪，首个 device-mouse-move 事件到来后再按命中区决定穿透态。
    void invoke('start_pet_mouse_stream').catch(() => {})
    void refreshWindowPosition()
    void appWindow.isVisible().then((visible) => {
      if (!disposed)
        handleVisibility(visible)
    }).catch(() => {})

    const movedPromise = appWindow.onMoved(() => {
      void refreshWindowPosition()
    })
    const resizedPromise = appWindow.onResized(() => {
      void refreshWindowPosition()
    })
    const statusPromise = listen<RustPetStatus>('pet://status', ({ payload }) => {
      // `visible` 恒等于 `enabled`（关闭宠物即销毁窗口，没有进程内瞬态），
      // 任一字段显式为 false 都视为窗口不可见。
      handleVisibility(payload.enabled !== false && payload.visible !== false)
    })
    const mouseMovePromise = listen<DeviceMousePosition>('device-mouse-move', ({ payload }) => {
      // 挂载时的位置刷新是异步的，首个事件到来时可能还没拿到窗口坐标；补拉一次，
      // 让初始命中判定尽快给出明确结果，由此把初始穿透态一次应用到位。
      if (windowPosition === undefined)
        void refreshWindowPosition()
      const inElement = isCursorInElement(payload.x, payload.y)
      if (inElement !== undefined)
        setIgnoreCursorEvents(!inElement)
    })

    void Promise.all([movedPromise, resizedPromise, mouseMovePromise, statusPromise]).then(([moved, resized, mouseMove, status]) => {
      if (disposed) {
        moved()
        resized()
        mouseMove()
        status()
      }
      else {
        unlistenMoved = moved
        unlistenResized = resized
        unlistenMouseMove = mouseMove
        unlistenStatus = status
      }
    }).catch(() => {})

    return () => {
      disposed = true
      geometryRevision++
      unlistenMoved?.()
      unlistenResized?.()
      unlistenMouseMove?.()
      unlistenStatus?.()
    }
  }, [elementRef])
}
