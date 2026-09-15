/**
 * host/open.ts — 系统默认方式打开 URL/目录（跨平台 spawn，windowsHide）。
 * 由 rightclick 等插件的宿主路由使用。
 */

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import process from 'node:process'

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function openUrl(url: string): Promise<void> {
  if (process.platform === 'win32') {
    await spawnDetached('rundll32.exe', ['url.dll,FileProtocolHandler', url])
    return
  }
  await spawnDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
}

/**
 * 在系统文件管理器中打开一个目录（宿主 sidecar 进程内调用）。
 * 与 panel-extension 的 opener 同一套实测约束：
 *   - explorer 对正斜杠路径会静默回落到默认文件夹，必须喂反斜杠；
 *   - 不能带 windowsHide（会把 SW_HIDE 写进 STARTUPINFO，explorer 首窗隐藏）；
 *   - 不能 await exit code（explorer 在多个 Windows 版本即使成功也非零退出）。
 * @returns 是否已成功启动系统文件管理器。
 */
export function openDirectory(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory())
      return false
  }
  catch {
    return false
  }
  if (process.platform === 'win32') {
    dir = dir.split('/').join('\\')
  }
  const launcher = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(launcher, [dir], { detached: true, stdio: 'ignore' })
    // 启动器解析失败时 'error' 异步到达；没有监听会升级成 uncaughtException 炸掉 sidecar。
    child.once('error', () => {})
    child.unref()
    return true
  }
  catch {
    return false
  }
}
