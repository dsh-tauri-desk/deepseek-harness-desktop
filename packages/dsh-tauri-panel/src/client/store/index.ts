/**
 * store.ts — 面板协议的状态层：会话区替换状态（ActionItem active 样式订阅源）。
 *
 * SnapshotStore 可安全保持模块级（插件重载时随 bundle 重建，可接受）。
 */

import { createExternalStore } from 'dsh-tauri/client'

/** 替换状态：当前替换视图 id（null = 官方会话区）。 */
export const panelViewStore = createExternalStore<{ id: string } | null>(null)
