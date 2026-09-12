import { invoke } from '@tauri-apps/api/core'
import i18next from 'i18next'
import { toast } from './toast'

/**
 * 把纯文本写入系统剪贴板，并统一给出成功 / 失败的 toast 提示。
 *
 * 走原生 `write_clipboard_text` 命令（`bridge::clipboard`），而不再用
 * `@tauri-apps/plugin-clipboard-manager`：后者在应用启动时于主线程创建并持有单例
 * `arboard::Clipboard`，在 Linux Wayland 合成器不支持 `ext-data-control`/
 * `wlr-data-control` 时会导致「复制运行日志」崩溃/挂死。原生命令按次在
 * `spawn_blocking` 中惰性新建短期剪贴板句柄，用完即弃，规避该崩溃。
 *
 * 提示收敛在这里，调用方不必再各写一份 toast：`message` 覆盖成功文案（默认
 * 「已复制到剪贴板」，可传 `t('messages.logs_copied')` 等更具体的文案）；
 * 失败时统一提示并**继续抛出**，调用方只需记录日志。
 */
export async function writeClipboardText(text: string, message?: string): Promise<void> {
  try {
    await invoke<void>('write_clipboard_text', { text })
    toast(message ?? i18next.t('messages.clipboard_copied'))
  }
  catch (error) {
    toast(i18next.t('messages.clipboard_failed'), { variant: 'danger' })
    throw error
  }
}
