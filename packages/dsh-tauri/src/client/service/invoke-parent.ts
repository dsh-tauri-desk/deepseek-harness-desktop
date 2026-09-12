import type { ParentMessage } from '../types'

/** 发送结果：`ok=false` 表示未送达（没有宿主 / payload 不可结构化克隆）。 */
export interface InvokeParentResult {
  ok: boolean
  /** `ok=false` 时的原因（postMessage 抛出的原始错误）。 */
  error?: unknown
}

/**
 * 向主窗口（宿主）发送一条桥消息 —— iframe 侧**发消息的唯一出口**。
 *
 * 只负责发送（fire-and-forget）：需要应答时配合 `listenParent` 按 nonce 匹配，
 * 见 `service/invoke.ts` 的 invoke 桥。
 *
 * 自身**不抛错**，用返回值表达失败：没有宿主（顶层窗口 `window.parent === window`）
 * 或宿主已销毁 / payload 不可克隆时返回 `{ ok: false, error }`。fire-and-forget 的
 * 调用方（导航桥、错误上报）忽略返回值即可；需要知道送达结果的调用方（invoke 桥）
 * 据此立即失败，而不是干等到超时。
 *
 * 所有自定义桥都必须经本函数发消息，不要各自写 `window.parent.postMessage(…)`。
 */
export function invokeParent(message: ParentMessage): InvokeParentResult {
  if (typeof window === 'undefined' || window.parent === window)
    return { ok: false, error: new Error('NO_HOST: parent window is not available') }
  try {
    window.parent.postMessage(message, '*')
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error }
  }
}
