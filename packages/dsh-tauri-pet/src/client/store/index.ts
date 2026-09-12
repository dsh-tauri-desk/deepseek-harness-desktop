import type { PetStatus } from '../types'
/**
 * store/index.ts — 桌宠状态缓存的轻量共享状态。
 *
 * 侧栏入口图标是原生 DOM 补丁按钮（非 React 组件），设置页是 settings.section
 * 的 React 组件，两者互不感知，因此用 dsh-tauri/client 提供的
 * `createExternalStore`（框架无关、uSES 安全，getSnapshot 保持同一引用直到
 * 真实变更）桥接：图标订阅快照切换绿点，设置页读写状态。不引入额外依赖。
 */
import { createExternalStore } from 'dsh-tauri/client'

/** 共享状态结构。 */
export interface PetShared {
  /** 最近一次从桌面端读回的桌宠状态缓存（图标绿点与设置页共用）。 */
  status: PetStatus | null
}

/** dsh-tauri 外部 store（getSnapshot 稳定，uSES 安全）。 */
export const petUiStore = createExternalStore<PetShared>({ status: null })
let fetchRevision = 0
/** Start a status fetch; only its latest revision may write the initial snapshot. */
export function beginPetStatusFetch(): number {
  fetchRevision += 1
  return fetchRevision
}
export function commitPetStatusFetch(revision: number, status: PetStatus): boolean {
  if (revision !== fetchRevision)
    return false
  petUiStore.set(state => (state.status === status ? state : { ...state, status }))
  return true
}

/** 订阅变更（供 useSyncExternalStore / DOM 补丁订阅）。 */
export function subscribePetUi(listener: () => void): () => void {
  return petUiStore.subscribe(listener)
}

/** 读取当前快照（供 useSyncExternalStore / DOM 补丁读取）。 */
export function getPetUiSnapshot(): PetShared {
  return petUiStore.getSnapshot()
}

/** 写入桌宠状态缓存。 */
export function setPetStatus(status: PetStatus | null): void {
  fetchRevision += 1
  petUiStore.set(state => (state.status === status ? state : { ...state, status }))
}
