/**
 * host/service/debug-log.ts — 统一日志（host 落盘 + client 回传）。
 *
 * 调试期专用：所有关键决策（收到的请求、算出的边界、fork/create 结果、失败原因）
 * 都落盘到 `$DSH_HOME/dsh-tauri-edit-message.log`，每行一条 JSONL。排查时只需要
 * 把整份日志贴出来即可，不必再猜。
 *
 * 设计约束：日志失败绝不影响功能（全部 try/catch，写入串行化避免交错）。
 * 设 `DSH_EDIT_MESSAGE_DEBUG=1` 时同时打到控制台。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import process from 'node:process'
import { dirname, join } from 'pathe'

let logFile: string | null = null
let queue: Promise<void> = Promise.resolve()

/** 日志文件路径（`$DSH_HOME/dsh-tauri-edit-message.log`）。 */
function resolveLogFile(): string {
  if (logFile !== null)
    return logFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  logFile = join(home, 'dsh-tauri-edit-message.log')
  return logFile
}

/** 追加一条日志（串行化；失败静默）。 */
export function logEvent(tag: string, message: string, data?: unknown): Promise<void> {
  const line = JSON.stringify({ t: new Date().toISOString(), tag, message, data: data ?? null })
  queue = queue.then(async () => {
    try {
      const file = resolveLogFile()
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${line}\n`, 'utf8')
    }
    catch {
      // 日志失败不影响功能。
    }
  })
  if (process.env.DSH_EDIT_MESSAGE_DEBUG === '1')
    console.warn('[dsh-tauri-edit-message]', tag, message, data ?? '')
  return queue
}
