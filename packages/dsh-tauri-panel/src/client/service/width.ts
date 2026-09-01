/**
 * service/width.ts — 面板内容区宽度控制器（方案 A 的机制侧）。
 *
 * 镜像 alpha dsh-client-ui-conversation ConversationRoot 的宽度协议，面板
 * 自给自足：自己的根元素发布变量、自己的手柄、自己的偏好读写，不依赖官方
 * 根元素（rc.2 下官方无这些变量也能工作）。协议层方法（方案 C：
 * setWidth/resetWidth/getWidth）也在这里，供 panel.protocol 装配。
 *
 * 能力探测：ResizeObserver / PointerEvent / requestAnimationFrame 任一缺失
 * （旧 WebView）→ supported=false，手柄不渲染、宽度固定（与现状一致），
 * 仅 console.warn 一次。
 */

import { createLifecycleController } from 'dsh-tauri/client'
import {
  PANEL_CONTENT_ADAPTIVE_MIN,
  PANEL_CONTENT_DEFAULT,
  PANEL_WIDTH_PREF_KEY,
  PANEL_WIDTH_VARS,
} from '../constants'
import { readWidthPreference, resolveContentWidth, writeWidthPreference } from '../utils/width'

/** 拖拽手柄的回调面（alpha WidthHandle 同名）。 */
export interface PanelWidthHandleCallbacks {
  /** 拖拽开始：返回当前解析宽度作为拖拽基数。 */
  onStart: () => number
  /** 拖拽中：写入实时偏好（px）。 */
  onDrag: (width: number) => void
  /** 拖拽结束（位移 ≠ 0）：持久化偏好（px）。 */
  onCommit: (width: number) => void
  /** 拖拽结束（任何情况）：重新发布变量（偏好清理后回退自适应）。 */
  onEnd: () => void
}

/** 宽度控制器：UI 侧（attach + handle）+ 协议侧（set/reset/get）共用。 */
export interface PanelWidthController {
  /** 能力探测结果：false 时 UI 不渲染手柄、固定宽度。 */
  supported: boolean
  /** 挂载根元素：ResizeObserver 发布列宽 + 偏好；返回 detach（disconnect）。 */
  attach: (root: HTMLElement) => () => void
  /** 手柄回调（WidthHandle 传入）。 */
  handle: PanelWidthHandleCallbacks
  /** 程序化设置内容宽度（clamp 到契约范围并持久化）。 */
  setWidth: (px: number) => void
  /** 清除宽度偏好，恢复自适应。 */
  resetWidth: () => void
  /** 当前内容宽度（含偏好；无根元素时返回偏好或 null）。 */
  getWidth: () => number | null
}

/** 能力探测（旧 WebView 无 Pointer capture / rAF / RO 时降级固定宽度）。 */
function detectWidthSupport(): boolean {
  if (typeof window === 'undefined')
    return false
  return typeof window.ResizeObserver === 'function'
    && typeof window.PointerEvent === 'function'
    && typeof window.requestAnimationFrame === 'function'
}

/** 创建宽度控制器（每次面板服务装配创建一次，重载时随 bundle 重建）。 */
export function createPanelWidthController(): PanelWidthController {
  const supported = detectWidthSupport()
  let warned = false
  let root: HTMLElement | null = null

  const warnOnce = (): void => {
    if (warned)
      return
    warned = true
    console.warn('[dsh-tauri-panel] width drag unsupported (ResizeObserver/PointerEvent missing) — fixed width.')
  }

  /** 把列宽 + 当前偏好发布到根元素 CSS 变量。 */
  function publishWidths(el: HTMLElement): void {
    const column = el.offsetWidth
    el.style.setProperty(PANEL_WIDTH_VARS.column, `${column}px`)
    const preference = readWidthPreference(window.localStorage)
    if (preference === null)
      el.style.removeProperty(PANEL_WIDTH_VARS.user)
    else
      el.style.setProperty(PANEL_WIDTH_VARS.user, `${resolveContentWidth(column, preference)}px`)
  }

  function attach(el: HTMLElement): () => void {
    root = el
    if (!supported) {
      warnOnce()
      return () => {
        root = null
      }
    }
    publishWidths(el)
    // 每次 attach 建独立生命周期：detach 时统一清理该次的 observer，
    // 面板重开（再次 attach）不会命中已 dispose 的旧控制器。
    const lifecycle = createLifecycleController()
    const observer = new ResizeObserver(() => publishWidths(el))
    observer.observe(el)
    lifecycle.add(() => observer.disconnect())
    return () => {
      lifecycle.dispose()
      root = null
    }
  }

  const handle: PanelWidthHandleCallbacks = {
    onStart() {
      if (!root)
        return PANEL_CONTENT_ADAPTIVE_MIN
      return resolveContentWidth(root.offsetWidth, readWidthPreference(window.localStorage))
    },
    onDrag(width) {
      if (!root)
        return
      const clamped = resolveContentWidth(root.offsetWidth, width)
      root.style.setProperty(PANEL_WIDTH_VARS.user, `${clamped}px`)
    },
    onCommit(width) {
      if (!root)
        return
      writeWidthPreference(window.localStorage, resolveContentWidth(root.offsetWidth, width))
    },
    onEnd() {
      if (root)
        publishWidths(root)
    },
  }

  function setWidth(px: number): void {
    const column = root?.offsetWidth ?? PANEL_CONTENT_DEFAULT
    const resolved = resolveContentWidth(column, px)
    writeWidthPreference(window.localStorage, resolved)
    if (root)
      root.style.setProperty(PANEL_WIDTH_VARS.user, `${resolved}px`)
  }

  function resetWidth(): void {
    window.localStorage.removeItem(PANEL_WIDTH_PREF_KEY)
    if (root)
      publishWidths(root)
  }

  function getWidth(): number | null {
    const preference = readWidthPreference(window.localStorage)
    if (!root)
      return preference
    return resolveContentWidth(root.offsetWidth, preference)
  }

  return { supported, attach, handle, setWidth, resetWidth, getWidth }
}
