import type { SettingsUiState } from './types'
import { createExternalStore } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { RAIL_WIDTH_MAX, RAIL_WIDTH_MIN } from './constants'

export { RAIL_WIDTH_DEFAULT } from './constants'
export type { SettingsUiState } from './types'

/**
 * store.ts — dsh-tauri-ui 设置侧边栏的共享 UI 状态。
 *
 * 触发器（sidebar.settings 槽内）与侧边栏（shell.overlay 槽内）是同一插件
 * 的两个独立注册条目，凭一个模块级 SnapshotStore 共享开关/当前分区/搜索词：
 *   - 触发器把 open 置 true（并可选跳到某分区）；
 *   - 侧边栏订阅 open/activeId/query 渲染，Esc 或“返回应用”置 false。
 *
 * createExternalStore 是框架无关的 uSES 安全状态源
 * （getSnapshot 在变更间返回同一引用；set 返回不可变新状态）。
 */
/**
 * 左栏宽度合约，与官方 sidebar 面板一致：
 * defineStore init sidebar:280，setSidebar clamp clampWidth(px, 264, 420)，关闭即忘
 * （官方“closing a panel forgets its drag width”——不持久化，重开回默认）。
 */
/** 钳制到左栏合约区间（镜像官方 clampWidth 语义）。 */
export function clampRailWidth(px: number): number {
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, px))
}

/** 全局唯一共享状态源（模块级单例；插件重载时随 bundle 重建，可接受）。 */
export const settingsStore = createExternalStore<SettingsUiState>({
  open: false,
  activeId: undefined,
  query: '',
  railWidth: undefined,
})

/** 打开侧边栏；可选直接跳到一个设置分区（onboarding 的 openSection 用）。 */
export function openSettings(sectionId?: string): void {
  settingsStore.set(s => ({
    ...s,
    open: true,
    ...(sectionId !== undefined ? { activeId: sectionId } : {}),
  }))
}

/** 关闭侧边栏并复位视图状态（与官方 close 的复位语义一致；宽度也即忘）。 */
export function closeSettings(): void {
  settingsStore.set(s => ({
    ...s,
    open: false,
    activeId: undefined,
    query: '',
    railWidth: undefined,
  }))
}

/** 切换左栏当前分区。 */
export function selectSection(id: string): void {
  settingsStore.set(s => ({ ...s, activeId: id }))
}

/** 拖拽中实时写入左栏宽度（调用方已按合约钳制）。 */
export function setRailWidth(px: number): void {
  settingsStore.set(s => ({ ...s, railWidth: px }))
}

/** 组件内读取 UI 状态（uSES；state 引用在 update 之间稳定）。 */
export function useSettingsUi(): SettingsUiState {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot)
}
