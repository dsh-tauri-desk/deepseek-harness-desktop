/** 记录动作（与宿主 `PluginError.action` 语义一致）。 */
export type ErrorAction = 'runtime' | 'install' | 'update' | 'remove'

// ── 父窗口桥（iframe ↔ 主窗口）共同的信封与形态 ────────────────────
/**
 * 主窗口（宿主）与 iframe 之间传递的桥消息（最小信封，按 `type` 分发）。
 *
 * 宿主侧不再比对 `source`：来源由「`event.source === window.parent` + origin」
 * 保证，协议分支只认 `type`。
 */
export interface ParentMessage {
  type?: string
  [key: string]: unknown
}

/** 取消监听函数（与 `@tauri-apps/api/event` 的 `UnlistenFn` 同形）。 */
export type UnlistenFn = () => void

/** 父窗口消息的 `type` 过滤器：单个类型或类型列表。 */
export type ParentMessageTypes = string | readonly string[]

/** 已校验的父窗口消息上下文。 */
export interface ParentMessageContext {
  /** 原始 message 事件（需要 `event.origin` 等原始信息时使用）。 */
  event: MessageEvent
}

/** Tauri 事件对象（与 `@tauri-apps/api/event` 的 `Event<T>` 同形，改名避免遮蔽 DOM `Event`）。 */
export interface TauriEvent<T> {
  event: string
  id: number
  payload: T
}

/** Tauri `listen` 的回调（与 `@tauri-apps/api/event` 的 `EventCallback<T>` 同形）。 */
export type EventCallback<T> = (event: TauriEvent<T>) => void

/** Tauri `listen` 的可选项；桥只支持主页面的缺省目标，`target` 目前不生效。 */
export interface Options {
  target?: string | EventTarget
}

/** Tauri `invoke` 的参数形态（与 `@tauri-apps/api/core` 的 `InvokeArgs` 同形）。 */
export type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array

/** Tauri `invoke` 的可选项；桥不转发 `headers`（宿主直接调用 command），仅为签名一致。 */
export interface InvokeOptions {
  headers: HeadersInit
}

/** 宿主 → iframe 的 Tauri 事件转发信封（`TYPE_EVENT`）。 */
export interface TauriEventBridgeMessage<T = unknown> extends ParentMessage {
  event: string
  /** Tauri 侧的事件 id；宿主未提供时为 0。 */
  id?: number
  payload: T
}

// ── dsh-tauri invoke 桥（iframe → 宿主 → invoke()）────────────────
/**
 * iframe → 宿主 的 invoke 请求（postMessage）。
 *
 * `extends ParentMessage`：本桥的信封与 `invokeParent` / `listenParent` 的
 * 最小信封同族（`type` 分发 + 允许额外字段），继承其索引签名才能直接作为
 * 这两个原语的参数类型。
 */
export interface InvokeBridgeRequest extends ParentMessage {
  source: 'dsh-tauri-invoke'
  type: 'dsh://tauri:invoke'
  /** Tauri command 名。 */
  cmd: string
  /** command 参数对象。 */
  args?: InvokeArgs
  /** 一次请求的唯一标识，宿主原样回填用于匹配。 */
  nonce: string
}

/** 宿主 → iframe 的 invoke 应答（postMessage）。 */
export interface InvokeBridgeReply extends ParentMessage {
  source: 'dsh-desktop-invoke'
  type: 'dsh://tauri:reply'
  nonce: string
  /** true=成功（value 有效）；false=失败（error 为 command 抛出的字符串）。 */
  ok: boolean
  value?: unknown
  error?: string
}
