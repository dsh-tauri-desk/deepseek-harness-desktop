/** clipboard.ts — 剪贴板读写（Clipboard API 优先，回退 execCommand 复制）。 */

import type { LocaleKey } from '../types'
import { text } from '../locales'
import { toast } from './dialog'

/** 回退复制：临时 textarea + document.execCommand（Clipboard API 不可写时兜底）。 */
function legacyCopy(value: string): void {
  const field = document.createElement('textarea')
  field.value = value
  field.setAttribute('readonly', '')
  field.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.appendChild(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  if (!copied)
    throw new Error(text('clipboardUnavailable'))
}

/** 写剪贴板（Clipboard API 失败时回退 execCommand）。 */
export async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    }
    catch {}
  }
  legacyCopy(value)
}

/** 读剪贴板（只读失败时抛出；宿主禁止读取时提示用 Ctrl+V）。 */
export async function readClipboard(): Promise<string> {
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText()
    }
    catch {}
  }
  throw new Error(text('clipboardReadFailed'))
}

/** 复制并 toast 一条成功提示。 */
export async function copyText(value: string, messageKey: LocaleKey): Promise<void> {
  await writeClipboard(value)
  toast(text(messageKey))
}
