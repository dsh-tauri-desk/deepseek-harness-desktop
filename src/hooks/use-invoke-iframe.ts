import type { RefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useIframeMessage } from '@/hooks/use-iframe-message'

/**
 * 壳层 invoke 桥（宿主侧）：把 iframe 内 dsh 界面/插件的 Tauri 调用
 * 转发到 `@tauri-apps/api/core` 的 `invoke`，再把结果回传给 iframe。
 *
 * 背景：dsh GUI 运行在 iframe 内，其触发的 Tauri command（如桌宠插件的
 * get_pet_status/set_pet_enabled）无法直接访问 `__TAURI_INTERNALS__`（只在
 * 顶层 webview）。dsh-tauri 客户端用 postMessage 把调用上报到主 webview，本
 * 监听器校验来源后执行 `invoke` 并回传。
 *
 * 协议（与 dsh-tauri client service/invoke.ts 逐字一致）：
 *   iframe → 宿主：{ source: 'dsh-tauri-invoke', type: 'dsh://tauri:invoke',
 *                     cmd, args, nonce }
 *   宿主 → iframe：{ source: 'dsh-desktop-invoke', type: 'dsh://tauri:reply',
 *                     nonce, ok, value | error }
 *
 * 来源与 origin 校验由 `useIframeMessage` 统一完成（直接 iframe + origin；
 * 宿主侧不比对 `data.source`，按 `type` 分发）；这里只负责白名单与转发。
 */
interface InvokeBridgeRequest {
  type?: string
  cmd?: string
  args?: Record<string, unknown>
  nonce?: string
}

/**
 * 允许 iframe 桥调用的 Tauri command 白名单（与 dsh-tauri-pet 的
 * service/pet.ts 一一对应）。凡新增可经桥调用的 command 必须在此登记，
 * 防止 iframe 内其他插件借道桥执行任意 Tauri command（越权）。
 */
const ALLOWED_INVOKE_CMDS = new Set([
  'get_pet_status',
  'set_pet_enabled',
  'set_active_pet',
  'set_pet_size',
  'push_pet_session',
  'list_pets',
  'import_pet',
  'get_pet_asset',
  'list_preset_pets',
])

export function useInvokeIframe(iframeRef: RefObject<HTMLIFrameElement | null>): void {
  useIframeMessage<InvokeBridgeRequest>(iframeRef, (data, { origin }) => {
    if (data.type !== 'dsh://tauri:invoke' || !data.cmd)
      return
    // 仅在白名单内的 command 允许调用，其余静默忽略（防越权）。
    if (!ALLOWED_INVOKE_CMDS.has(data.cmd)) {
      console.warn(`[iframe-invoke] ignored non-allowlisted cmd: ${data.cmd}`)
      return
    }
    const cmd = data.cmd
    const args = data.args
    const nonce = data.nonce ?? ''

    function reply(payload: { ok: boolean, value?: unknown, error?: string }) {
      iframeRef.current?.contentWindow?.postMessage(
        { source: 'dsh-desktop-invoke', type: 'dsh://tauri:reply', nonce, ...payload },
        origin,
      )
    }
    // 统一以字符串承载错误（command 已按约定 `Result<_, String>` 返回带前缀 error）。
    void invoke<unknown>(cmd, args)
      .then(value => reply({ ok: true, value }))
      .catch((error: unknown) => {
        console.error(`[iframe-invoke] ${cmd} failed:`, error)
        reply({
          ok: false,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        })
      })
  })
}
