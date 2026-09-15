import type { EventCallback, Options, TauriEvent, TauriEventBridgeMessage, UnlistenFn } from '../types'
import { TYPE_EVENT } from '../constants'
import { listenParent } from './listen-parent'

/**
 * 订阅一个「宿主转发进 iframe 的 Tauri 事件」。
 *
 * iframe 内的插件没有 `__TAURI_INTERNALS__`，无法直接 `import { listen } from
 * '@tauri-apps/api/event'`；由宿主（主 webview）订阅 Tauri 事件后按协议转发进来：
 *
 *   宿主 → iframe：{ source: 'dsh-desktop', type: 'dsh://tauri:event', event, payload }
 *
 * 桌面端的配对写法（`src/layout/components/iframe.tsx` 一类的宿主代码）：
 *   `useListenIframe(iframeRef, event, payload => ({ type: 'dsh://tauri:event', event, payload }))`
 *
 * 签名与 `@tauri-apps/api/event` 的 `listen` 保持一致（含返回 `Promise<UnlistenFn>`），
 * 便于调用方按同一种写法使用；`options.target` 目前不生效（桥只转发到当前 iframe）。
 */
export function listen<T>(
  event: string,
  handler: EventCallback<T>,
  _options?: Options,
): Promise<UnlistenFn> {
  const unlisten = listenParent<TauriEventBridgeMessage<T>>((message) => {
    if (message.event !== event)
      return
    handler({
      event: message.event,
      // 宿主未提供 id 时回落 0（Tauri 的 Event.id 为数字，此处保持一致形状）
      id: typeof message.id === 'number' ? message.id : 0,
      payload: message.payload,
    } satisfies TauriEvent<T>)
  }, TYPE_EVENT)

  return Promise.resolve(unlisten)
}
