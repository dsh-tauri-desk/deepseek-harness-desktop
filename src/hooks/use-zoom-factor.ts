import type { Webview } from '@tauri-apps/api/webview'
import type { RefObject } from 'react'
import { useMount, useWatch } from '@reause/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { type, version } from '@tauri-apps/plugin-os'
import { useRef, useState } from 'react'

/**
 * Tauri 版 `useZoomFactor`：签名与 `@reause/electron` 的同名 hook 完全一致
 * （响应式 WebView 缩放比例），底层改用 Tauri 的 WebView / Window API。
 *
 * ```ts
 * const [factor, setFactor] = useZoomFactor() // 读当前比例
 * const [factor] = useZoomFactor(2) // 挂载时应用显式比例
 * const [factor] = useZoomFactor(webview, 2) // 指定 WebView 实例 + 显式比例
 * setFactor(2) // webview.setZoom(2)
 * ```
 *
 * 与 Electron 版的平台差异（Tauri 2 JS API 的现状，无法在 hook 内消除）：
 * - **写**：只有 `Webview.setZoom(scaleFactor)`（形参在 Tauri 文档里就叫 `scaleFactor`）；
 *   没有 `Window.setScaleFactor`——窗口缩放因子由系统决定，JS 无法设置。
 * - **读**：没有 `Webview.getZoom`（无比例回读接口），唯一可读的比例是
 *   `Window.scaleFactor()`（显示器 DPI 缩放）。因此**初值**取 `Window.scaleFactor()`，
 *   之后返回值跟随 `setFactor` / 显式来源；外部改动（其它代码直接调 `setZoom`）
 *   无法反映到本 hook，这是平台缺口而非实现取舍。
 * - Electron 的 `setZoomFactor` 同步执行（同步抛错）；Tauri 的 `setZoom` 返回 Promise，
 *   所以 setter 仍保持 `(value: number) => void`，失败只记录日志。
 * - Electron 版的 `watch(..., { immediate: true })` 在这里用 reause `useWatch` 表达，
 *   并用 ref 记住「最后一次写入的比例」，重复渲染不会重复写入同一个值。
 * - macOS 10.15 及更早没有 `WKWebView.pageZoom`（wry 直接调用该选择器、没有
 *   `#available` 守卫），在旧系统上应用缩放会崩，因此这里用 `@tauri-apps/plugin-os`
 *   读取系统版本，只在 macOS 11+ 才真正调用 `setZoom`（其余平台一律应用）。
 */

/**
 * 与 reause `RefOrValue<T>` 对齐的本地别名（本仓库不直接依赖 `@reause/shared`）。
 */
export type RefOrValue<T> = T | RefObject<T>

/**
 * `useZoomFactor` 返回的 setter：校验比例、写入 `Webview.setZoom`、更新 hook 返回值。
 */
export type ZoomFactorSetter = (value: number) => void

/** 与 reause / VueUse 同款文案：比例为 0 时抛错（负数交由平台判定） */
const ZOOM_FACTOR_ERROR = 'the factor must be greater than 0.0.'

function assertZoomFactor(value: number): void {
  if (value === 0)
    throw new Error(ZOOM_FACTOR_ERROR)
}

/** ref 形态判定（对应 `@reause/shared` 的 `isRefLike`） */
export function isRefLike(value: unknown): value is RefObject<number> {
  return !!value && typeof value === 'object' && 'current' in value
}

/** 取值：ref 取 `current`，否则原样返回（对应 `@reause/shared` 的 `toValue`） */
export function toValue(value: RefOrValue<number>): number {
  return isRefLike(value) ? value.current : value
}

// 与 Electron 版同一套 overload 判别：首参是 number / ref 即「未显式传 WebView」
function isFactorArgument(value: Webview | RefOrValue<number> | undefined): value is RefOrValue<number> {
  return typeof value === 'number' || isRefLike(value)
}

/** macOS 起支持 `WKWebView.pageZoom`（原生 WebView 缩放）的主版本 */
const MIN_MACOS_ZOOM_MAJOR = 11

/**
 * 当前平台能否把缩放应用到 WebView。
 *
 * wry 在 macOS 上直接调用 `WKWebView.pageZoom`（macOS 11+ 才有，且没有 `#available`
 * 守卫），在 10.15 及更早会因未识别选择器崩溃，所以先用 `@tauri-apps/plugin-os`
 * 读取系统版本再决定；其余平台一律支持。
 */
function isNativeZoomSupported(): boolean {
  try {
    if (type() !== 'macos')
      return true
    const major = Number.parseInt(version().split('.')[0] ?? '', 10)
    return Number.isFinite(major) ? major >= MIN_MACOS_ZOOM_MAJOR : true
  }
  catch (error) {
    // OS 插件不可用（未注册/未安装）：拿不到系统版本时按支持处理，避免功能整块静默失效
    console.warn('[useZoomFactor] failed to read the OS version, assuming native zoom is supported:', error)
    return true
  }
}

/**
 * 响应式 WebView 缩放比例（Tauri）。
 *
 * @param factor 显式比例（number 或 ref）：挂载时应用一次，之后随来源变化重应用
 * @returns `[factor, setFactor]`：当前比例与写入函数
 *
 * @example
 * const [factor, setFactor] = useZoomFactor()
 * setFactor(1.5)
 *
 * @example
 * const [factor] = useZoomFactor(webview, 2) // 指定实例并应用显式比例
 */
export function useZoomFactor(factor?: RefOrValue<number>): [number, ZoomFactorSetter]
export function useZoomFactor(webview: Webview, factor?: RefOrValue<number>): [number, ZoomFactorSetter]
export function useZoomFactor(
  webviewOrFactor?: Webview | RefOrValue<number>,
  factor?: RefOrValue<number>,
): [number, ZoomFactorSetter] {
  const webview = isFactorArgument(webviewOrFactor) ? undefined : webviewOrFactor
  const externalFactor = isFactorArgument(webviewOrFactor) ? webviewOrFactor : factor

  // 未显式传入时作用到当前 WebView（对应 Electron 版从 `window.require('electron')` 解析 webFrame）
  const target = webview ?? getCurrentWebview()

  const resolvedFactor = externalFactor === undefined ? undefined : toValue(externalFactor)
  if (resolvedFactor !== undefined)
    assertZoomFactor(resolvedFactor)

  // 平台能力（macOS < 11 没有 `WKWebView.pageZoom`）：不支持时只维护返回值，不触碰 WebView
  const supported = isNativeZoomSupported()

  const [value, setValue] = useState<number>(() => resolvedFactor ?? 1)

  // 读：Tauri 没有比例 getter，`Window.scaleFactor()` 是唯一可读比例；显式传入来源时
  // 它本身就是目标值，不再回读。
  useMount(() => {
    if (resolvedFactor !== undefined)
      return
    getCurrentWindow()
      .scaleFactor()
      .then(setValue)
      .catch(error => console.error('[useZoomFactor] scaleFactor failed:', error))
  })

  // 最后一次真正写入 `setZoom` 的比例（`null` = 尚未写过，保证显式来源在挂载时也会被应用）
  const lastAppliedRef = useRef<number | null>(null)

  // 显式来源：首次运行即 Electron 版的 `immediate: true`（挂载应用一次），
  // 之后仅在来源变化到不同值时重应用。
  useWatch(supported ? resolvedFactor : undefined, (next) => {
    if (next === undefined || next === lastAppliedRef.current)
      return
    assertZoomFactor(next)
    lastAppliedRef.current = next
    setValue(next)
    void target.setZoom(next).catch(error => console.error('[useZoomFactor] setZoom failed:', error))
  }, { immediate: true })

  function setFactor(nextFactor: number) {
    assertZoomFactor(nextFactor)
    // Tauri 没有回读接口：本地状态即「最后一次写入的比例」
    lastAppliedRef.current = nextFactor
    setValue(nextFactor)
    if (!supported) {
      console.warn('[useZoomFactor] native webview zoom is unsupported on this platform; the value is kept without applying')
      return
    }
    void target.setZoom(nextFactor).catch(error => console.error('[useZoomFactor] setZoom failed:', error))
  }

  return [value, setFactor]
}
