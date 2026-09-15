import type { TauriEventBridgeMessage } from '../types/bridge'
import type { EventCallback, Options, TauriEvent, UnlistenFn } from '../types/tauri'
import { listenParent } from './listen-parent'

export function listen<T>(
  event: string,
  handler: EventCallback<T>,
  _options?: Options,
): Promise<UnlistenFn> {
  const unlisten = listenParent<TauriEventBridgeMessage<T>>(
    (message) => {
      if (message.event !== event)
        return
      handler({
        event: message.event,
        // 宿主未提供 id 时回落 0（Tauri 的 Event.id 为数字，此处保持一致形状）
        id: typeof message.id === 'number' ? message.id : 0,
        payload: message.payload,
      } satisfies TauriEvent<T>)
    },
    'dsh://tauri:event',
  )

  return Promise.resolve(unlisten)
}
