/**
 * Open a directory in the OS file manager, from the dsh sidecar process.
 * Spawned detached with all stdio ignored — a GUI file manager needs no
 * pipes, and explorer.exe reports failure through exit codes we must not
 * await (it exits non-zero even on success in several Windows versions).
 */

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import process from 'node:process'

/** Open one directory; resolves true when a launcher was started. */
export function openDirectory(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory())
      return false
  }
  catch {
    return false
  }
  if (process.platform === 'win32') {
    // explorer 对正斜杠路径会静默回落到默认文件夹（实测打开成了「文档」），必须喂反斜杠。
    dir = dir.split('/').join('\\')
  }
  const launcher = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    // GUI 启动器不能带 windowsHide：该 flag 把 SW_HIDE 写进 STARTUPINFO，explorer 的
    // 首个窗口据此创建为隐藏——实机表现是「打开目录」点了没反应，窗口其实开了。
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
