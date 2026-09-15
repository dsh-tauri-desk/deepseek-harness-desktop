import type { ILayout, LocaleService } from './inject'

/**
 * 槽位条目的注册选项子集（list/keyed 槽的投影只读这几项）。
 *
 * `label` 与上游 `SlotLabel` 一致：可以是 thunk，读时才求值，
 * 因此本地化文案无需重新注册（对齐上游 `resolveSlotLabel`）。
 */
export interface SlotEntryOptions {
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
  priority?: number
}

/** 一个已注册槽位条目的只读投影（`entriesOfSlot` 的元素）。 */
export interface SlotEntryLike {
  options: SlotEntryOptions
}

/**
 * 客户端 slots 注册中心（dsh 核心 runtime 注入）的最小契约。
 * 槽位注册统一走 ctx.slots.inject(slot, setup) + ctx.slots.register(...)。
 *
 * `entriesOfSlot` / `subscribe` 用于宿主侧投影官方 list 槽（如 0.1.5-rc.1 的
 * `sidebar.panellist`）：前者读活条目，后者在声明/注册/注销时通知。
 * 旧核心（≤0.1.2-rc.1）的 slots 服务没有这两个方法，消费方必须能力探测。
 */
export interface ClientSlots {
  inject: (slot: string, setup: () => unknown) => () => void
  register: (slot: unknown, component: unknown) => () => void
  entriesOfSlot?: (slot: string) => readonly SlotEntryLike[]
  subscribe?: (slot: string, listener: () => void) => () => void
}

/** 反射服务（dsh 核心 runtime 注入）：服务注册（provide）与取用（get）。 */
export interface ClientReflect {
  get: <T = unknown>(key: string) => T | undefined
  provide: (key: string, value: unknown) => () => void
}

/** 生命周期方法（cordis Context 同款；卸载时执行 disposer，支持一次性注册多个）。 */
export type ClientEffect = (
  callback: () => void | (() => void) | Array<() => void>,
  id?: string,
) => void

/**
 * Client context with the client services consumed by the Tauri plugins.
 *
 * 自包含契约（不依赖上游 cordis 的类型解析）：只声明本 workspace 客户端
 * 插件实际消费的成员——locale / layout / slots / reflect / effect /
 * sessions / workspaces（后两者为宿主服务，消费方自行断言领域类型）。
 */
export interface ClientContext {
  locale: LocaleService
  layout: ILayout
  slots: ClientSlots
  reflect: ClientReflect
  effect: ClientEffect
  sessions?: unknown
  workspaces?: unknown
}
