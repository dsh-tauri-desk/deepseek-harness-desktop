/**
 * utils/width.ts — 面板内容区宽度拖拽的纯函数（方案 A）。镜像 alpha
 * dsh-client-ui-conversation ConversationRoot 的宽度解析语义，可单测。
 *
 * 所有函数不触碰 DOM / localStorage（storage 以参数注入），宿主组件只负责
 * 接线（ResizeObserver + 变量写入），保证契约一致且降级路径可验证。
 */

import {
  PANEL_CONTENT_ADAPTIVE_MAX,
  PANEL_CONTENT_ADAPTIVE_MIN,
  PANEL_CONTENT_EDGE_BUDGET,
  PANEL_CONTENT_MIN,
  PANEL_WIDTH_PREF_KEY,
} from '../constants'

/** localStorage 的最小可用面（getItem/setItem/removeItem 即可）。 */
export interface WidthPreferenceStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/**
 * 读取持久化的宽度偏好；持久化存储边界，缺失/损坏统一解析为「无偏好」。
 * @param storage - 任意满足 StorageLike 的存储（默认 localStorage）。
 * @returns 偏好宽度（px），未设置或非法时返回 null。
 */
export function readWidthPreference(storage: Pick<WidthPreferenceStorage, 'getItem'>): number | null {
  const raw = storage.getItem(PANEL_WIDTH_PREF_KEY)
  if (raw === null)
    return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 写入持久化的宽度偏好（四舍五入到整数 px，与官方写入一致）。
 * @param storage - 任意满足 StorageLike 的存储。
 * @param px - 要持久化的宽度（px）。
 */
export function writeWidthPreference(storage: Pick<WidthPreferenceStorage, 'setItem'>, px: number): void {
  storage.setItem(PANEL_WIDTH_PREF_KEY, `${Math.round(px)}`)
}

/** 把 px clamp 进 [min, max] 闭区间。 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(Math.max(px, min), max)
}

/**
 * 解析内容宽度（镜像 alpha `resolveContentWidth` 语义）：
 *   - 有偏好：clamp 进 `[CONTENT_MIN, max(CONTENT_MIN, column - EDGE_BUDGET)]`；
 *   - 无偏好：自适应 `clamp(680px, column * .64, 920px)`。
 * @param columnWidth - 对话列当前渲染宽度（px）。
 * @param preference - 拖拽偏好（px），或 null 表示无偏好。
 * @returns 解析后的内容宽度（px）。
 */
export function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(PANEL_CONTENT_MIN, columnWidth - PANEL_CONTENT_EDGE_BUDGET)
  if (preference !== null)
    return clampWidth(preference, PANEL_CONTENT_MIN, max)
  return Math.max(PANEL_CONTENT_ADAPTIVE_MIN, Math.min(columnWidth * 0.64, PANEL_CONTENT_ADAPTIVE_MAX))
}
