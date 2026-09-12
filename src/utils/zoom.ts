export type ZoomAction = 'increase' | 'decrease' | 'reset'

export interface ZoomShortcutLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** iframe 缩放桥消息：宿主按 `type` 分发（来源由 `useIframeMessage` 的 origin 校验负责）。 */
interface ZoomBridgeMessage {
  type: 'dsh://zoom-shortcut'
  action: ZoomAction
}

export function zoomActionFromShortcut(shortcut: ZoomShortcutLike): ZoomAction | null {
  if ((!shortcut.ctrlKey && !shortcut.metaKey) || shortcut.altKey)
    return null

  if (shortcut.key === '+' || shortcut.key === '=')
    return 'increase'
  if (shortcut.key === '-' || shortcut.key === '_')
    return 'decrease'
  if (shortcut.key === '0')
    return 'reset'
  return null
}

export function zoomActionFromBridgeMessage(value: unknown): ZoomAction | null {
  if (!value || typeof value !== 'object')
    return null

  const message = value as Partial<ZoomBridgeMessage>
  // 不再校验 `source`：宿主侧由 `useIframeMessage` 的 origin 校验保证来源，
  // 这里只认协议类型与动作（iframe 侧脚本仍会带 source 字段，多一个字段无影响）。
  if (message.type !== 'dsh://zoom-shortcut')
    return null
  if (message.action === 'increase' || message.action === 'decrease' || message.action === 'reset')
    return message.action
  return null
}

/**
 * Chromium 缩放级别底数：`factor = 1.2^level`。
 *
 * Electron `WebFrame.setZoomLevel` 内部就是这条换算（Tauri 的 WebView 只有比例、
 * 没有级别概念，级别需要在这里换算后落到 `Webview.setZoom`）。
 */
const ZOOM_LEVEL_BASE = 1.2

/** 缩放级别 → 缩放比例 */
export function zoomFactorFromLevel(level: number): number {
  return ZOOM_LEVEL_BASE ** level
}

/** 缩放比例 → 缩放级别（比例不是 1.2 的整数次幂时返回小数） */
export function zoomLevelFromFactor(factor: number): number {
  return Math.log(factor) / Math.log(ZOOM_LEVEL_BASE)
}

/** 默认缩放比例（100%），与 Rust `default_zoom_factor` 一致 */
export const ZOOM_FACTOR_DEFAULT = 1

/** 缩放步长，与 Rust `ZOOM_FACTOR_STEP` 一致 */
export const ZOOM_FACTOR_STEP = 0.1

/** 缩放下限，与 Rust `ZOOM_FACTOR_MIN` 一致 */
export const ZOOM_FACTOR_MIN = 0.5

/** 缩放上限，与 Rust `ZOOM_FACTOR_MAX` 一致 */
export const ZOOM_FACTOR_MAX = 2

/**
 * 归一化缩放比例：夹取到 [0.5, 2.0] 并对齐 0.1 步长
 * （等价 Rust `normalize_zoom_factor`；非有限值回落默认 100%）。
 *
 * 缩放真值存在 `store.setting.zoom_factor`（与 Rust 共享 `.store.dat`，Rust 读取时
 * 会再做一次同样的归一化），这里保证前端写入前就落在合法档位上，避免出现
 * 「设置面板选项选不中当前值」这类视觉漂移。
 */
export function normalizeZoomFactor(value: number): number {
  if (!Number.isFinite(value))
    return ZOOM_FACTOR_DEFAULT
  const grid = 1 / ZOOM_FACTOR_STEP
  const clamped = Math.min(Math.max(value, ZOOM_FACTOR_MIN), ZOOM_FACTOR_MAX)
  return Math.round(clamped * grid) / grid
}

/** 按缩放动作计算下一档比例（increase/decrease 走 0.1 步长，reset 回 100%） */
export function nextZoomFactor(current: number, action: ZoomAction): number {
  if (action === 'reset')
    return ZOOM_FACTOR_DEFAULT
  const delta = action === 'increase' ? ZOOM_FACTOR_STEP : -ZOOM_FACTOR_STEP
  return normalizeZoomFactor(current + delta)
}
