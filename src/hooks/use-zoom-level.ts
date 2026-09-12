import type { Webview } from '@tauri-apps/api/webview'
import type { RefOrValue } from '@/hooks/use-zoom-factor'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isRefLike, toValue, useZoomFactor } from '@/hooks/use-zoom-factor'
import { zoomFactorFromLevel, zoomLevelFromFactor } from '@/utils/zoom'

/**
 * Tauri 版 `useZoomLevel`：签名与 `@reause/electron` 的同名 hook 完全一致
 * （响应式 WebView 缩放级别），底层改用 Tauri 的 WebView API。
 *
 * ```ts
 * const [level, setLevel] = useZoomLevel() // 读当前级别
 * const [level] = useZoomLevel(2) // 挂载时应用显式级别
 * const [level] = useZoomLevel(webview, 2) // 指定 WebView 实例 + 显式级别
 * setLevel(2) // webview.setZoom(1.2 ** 2)
 * ```
 *
 * 与 Electron 版的平台差异：
 * - Tauri 的 WebView **只有比例没有级别**（`Webview.setZoom`），因此级别一律按 Chromium
 *   的底数 1.2 换算（`factor = 1.2^level`，与 Electron `setZoomLevel` 的内部换算一致），
 *   映射为比例后复用 `useZoomFactor` 的读写通路（含初值读取与显式来源重应用）。
 * - 回报的级别由比例反推，因此**可能是小数**：Tauri 侧比例不限于 1.2 的整数次幂
 *   （例如比例 1.4 对应级别 ≈ 1.8407），而 Electron 的 `getZoomLevel()` 同样可能返回小数。
 * - Electron 版对级别没有取值范围校验（`0` 是合法级别），这里保持一致：不额外设限。
 */

/**
 * `useZoomLevel` 返回的 setter：把级别换算为比例后写入（Tauri 只有比例）。
 */
export type ZoomLevelSetter = (value: number) => void

// 与 Electron 版同一套 overload 判别：首参是 number / ref 即「未显式传 WebView」
function isLevelArgument(value: Webview | RefOrValue<number> | undefined): value is RefOrValue<number> {
  return typeof value === 'number' || isRefLike(value)
}

/**
 * 响应式 WebView 缩放级别（Tauri）。
 *
 * @param level 显式级别（number 或 ref）：挂载时应用一次，之后随来源变化重应用
 * @returns `[level, setLevel]`：当前级别与写入函数
 *
 * @example
 * const [level, setLevel] = useZoomLevel()
 * setLevel(2) // webview.setZoom(1.44)
 *
 * @example
 * const [level] = useZoomLevel(webview, 0) // 指定实例并应用显式级别
 */
export function useZoomLevel(level?: RefOrValue<number>): [number, ZoomLevelSetter]
export function useZoomLevel(webview: Webview, level?: RefOrValue<number>): [number, ZoomLevelSetter]
export function useZoomLevel(
  webviewOrLevel?: Webview | RefOrValue<number>,
  level?: RefOrValue<number>,
): [number, ZoomLevelSetter] {
  const webview = isLevelArgument(webviewOrLevel) ? undefined : webviewOrLevel
  const externalLevel = isLevelArgument(webviewOrLevel) ? webviewOrLevel : level

  // 级别 → 比例（显式级别才换算；无显式来源时由 useZoomFactor 读当前值）
  const externalFactor = externalLevel === undefined ? undefined : zoomFactorFromLevel(toValue(externalLevel))

  // 恒走「实例 + 比例」这一支 overload：未显式传入时作用到当前 WebView，
  // 避免条件式调用 hook（rules-of-hooks）。
  const [factor, setFactor] = useZoomFactor(webview ?? getCurrentWebview(), externalFactor)

  function setLevel(nextLevel: number) {
    setFactor(zoomFactorFromLevel(nextLevel))
    // 与 Electron 版一致：ref 形态的来源是唯一真值通道，写入后回填调用方的 ref
    if (isRefLike(externalLevel))
      externalLevel.current = nextLevel
  }

  return [zoomLevelFromFactor(factor), setLevel]
}
