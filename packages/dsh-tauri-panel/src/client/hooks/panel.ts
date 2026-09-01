/**
 * hooks/panel.ts — 面板协议相关 React hooks。
 */

import { useSyncExternalStore } from 'react'
import { panelViewStore } from '../store'

/** 订阅当前替换 id（null = 官方会话区）。 */
export function usePanelViewId(): { id: string } | null {
  return useSyncExternalStore(
    fn => panelViewStore.subscribe(fn),
    () => panelViewStore.getSnapshot(),
  )
}
