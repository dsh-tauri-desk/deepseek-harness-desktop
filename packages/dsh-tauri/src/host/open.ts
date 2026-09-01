/**
 * host/open.ts — 系统默认方式打开 URL/目录（跨平台 spawn，windowsHide）。
 * 由 rightclick 等插件的宿主路由使用。
 */

import { spawn } from 'node:child_process'
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
