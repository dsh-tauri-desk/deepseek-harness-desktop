/**
 * client/dom/debug-log.ts — 客户端调试日志。
 *
 * 通过 `/message-tree/log` 把关键步骤回传到宿主，与宿主自己的日志落在同一个文件
 * （`$DSH_HOME/dsh-tauri-edit-message.log`），于是「点了什么 → 算了什么边界 →
 * fork/create 拿到什么」是一条时间线。日志失败一律静默，绝不影响编辑本身。
 */

import { EDIT_MESSAGE_PLUGIN_NAME, MESSAGE_TREE_PATH } from '../constants'

/** 回传一条日志（fire-and-forget；用 keepalive 保证跳转/卸载时也能送出）。 */
export function logEvent(tag: string, message: string, data?: unknown): void {
  try {
    const body = JSON.stringify({ plugin: EDIT_MESSAGE_PLUGIN_NAME, tag, message, data: data ?? null })
    void fetch(`${MESSAGE_TREE_PATH}/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  }
  catch {
    // 日志失败不影响功能。
  }
}
