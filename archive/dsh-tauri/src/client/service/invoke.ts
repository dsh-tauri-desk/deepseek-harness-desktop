import type { InvokeArgs, InvokeBridgeReply, InvokeBridgeRequest, InvokeOptions } from '../types'
import { INVOKE_TIMEOUT_MS, PLUGIN_ID, SRC_INVOKE, TYPE_INVOKE, TYPE_INVOKE_REPLY } from '../constants'
import { invokeParent } from './invoke-parent'
import { listenParent } from './listen-parent'

/**
 * dsh-tauri invoke 桥（iframe 侧客户端）。
 *
 * iframe 内的 dsh 界面 / 插件没有 `__TAURI_INTERNALS__`（只有顶层 webview 有），
 * 因此无法直接 `import { invoke } from '@tauri-apps/api/core'`。本桥把这些调用
 * 经 postMessage 转发到宿主（主 webview）的监听器（见桌面端
 * `src/hooks/use-invoke-iframe.ts`），由宿主调用 Tauri `invoke` 并把结果回传。
 *
 * 协议（与宿主监听器逐字一致）：
 *   iframe → 宿主：{ source: 'dsh-tauri-invoke', type: 'dsh://tauri:invoke',
 *                     cmd, args, nonce }
 *   宿主 → iframe：{ source: 'dsh-desktop-invoke', type: 'dsh://tauri:reply',
 *                     nonce, ok, value | error }
 *
 * 收发都走父窗口桥原语（`invokeParent` / `listenParent`），本文件只负责
 * nonce 匹配、超时与错误归一。
 */

let nonceSeq = 0

/** 生成全局唯一的请求 nonce（`<pluginId>:<seq>`，进程内递增）。 */
function nextNonce(): string {
  nonceSeq += 1
  return `${PLUGIN_ID}:${nonceSeq}`
}

/**
 * 经宿主桥调用一个 Tauri command，返回其成功值；command 抛错或超时时 reject。
 *
 * 签名与 `@tauri-apps/api/core` 的 `invoke` 保持一致（`cmd` / `args` / `options`），
 * 便于把 `import { invoke } from '@tauri-apps/api/core'` 原地换成此实现；
 * `options.headers` 不被桥转发（宿主直接调用 command），仅为签名一致而保留。
 *
 * @param cmd Tauri command 名（如 `get_pet_status`）
 * @param args command 参数（对象 / 数字数组 / ArrayBuffer / Uint8Array）
 * @typeParam T command 成功返回值的类型
 */
export function invoke<T>(
  cmd: string,
  args?: InvokeArgs,
  _options?: InvokeOptions,
): Promise<T> {
  const nonce = nextNonce()

  return new Promise<T>((resolve, reject) => {
    let settled = false
    // 定时器句柄：settle 成功/失败路径与 postMessage 抛错路径都要清理，避免高频
    // 成功调用留下一 15s 的休眠超时闭包（见 issue #396 前端延迟根因之一）。
    let timer: ReturnType<typeof setTimeout> | undefined

    // 只接受宿主回传且 nonce 命中本次请求的应答（来源由 listenParent 校验）
    const unlisten = listenParent<InvokeBridgeReply>((reply) => {
      if (reply.type !== TYPE_INVOKE_REPLY || reply.nonce !== nonce)
        return
      settle(reply)
    })

    function settle(reply: InvokeBridgeReply): void {
      if (settled)
        return
      settled = true
      if (timer !== undefined)
        clearTimeout(timer)
      // issue #396 修复：完成路径（成功/失败）都必须清理超时计时器，避免高频成功调用遗留「休眠超时闭包」。
      unlisten()
      if (reply.ok) {
        resolve(reply.value as T)
      }
      else {
        reject(new Error(reply.error || `NODE_NOT_ANSWERED: invoke ${cmd} rejected by host`))
      }
    }

    // 超时保护：宿主未应答（监听器未挂载/iframe 非 dsh 环境等）时按失败处理
    timer = setTimeout(() => {
      if (settled)
        return
      unlisten()
      settled = true
      reject(new Error(`NODE_NOT_ANSWERED: invoke ${cmd} timed out`))
    }, INVOKE_TIMEOUT_MS)

    const request: InvokeBridgeRequest = {
      source: SRC_INVOKE,
      type: TYPE_INVOKE,
      cmd,
      args,
      nonce,
    }
    // 未送达（无宿主 / payload 不可克隆）时立即失败，不等超时
    const sent = invokeParent(request)
    if (!sent.ok) {
      if (timer !== undefined)
        clearTimeout(timer)
      if (settled)
        return
      settled = true
      unlisten()
      reject(sent.error ?? new Error(`NODE_NOT_ANSWERED: invoke ${cmd} not delivered`))
    }
  })
}
