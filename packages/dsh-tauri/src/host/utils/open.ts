import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import process from 'node:process'
import { spawnDetached } from './spawn'

export async function openUrl(url: string): Promise<void> {
  if (process.platform === 'win32') {
    await spawnDetached('rundll32.exe', ['url.dll,FileProtocolHandler', url])
    return
  }
  await spawnDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
}

/**
 * 在系统文件管理器中打开一个目录。
 *
 * 平台实测约束（与桌面壳/消费插件共用同一套结论，改动前请先在 Windows 上验证）：
 *   - explorer 对正斜杠路径会静默回落到默认文件夹，必须喂反斜杠；
 *   - **不能带 `windowsHide`**：它会把 SW_HIDE 写进 STARTUPINFO，explorer 首窗被隐藏
 *     （因此这里不用 `spawnDetached`，后者固定 `windowsHide: true`）；
 *   - 不能 await 退出码：explorer 在多个 Windows 版本即使成功也非零退出；
 *   - `'error'` 必须挂监听：启动器解析失败是异步到达的，无人监听会升级成
 *     uncaughtException 炸掉宿主 sidecar。
 *
 * 路径不存在或不是目录时抛错（调用方据此回 400），绝不静默什么都不做。
 */
export async function openDirectory(dir: string): Promise<void> {
  if (!statSync(dir).isDirectory())
    throw new Error(`Path is not a directory: ${dir}`)

  const normalizedDir = process.platform === 'win32' ? dir.replace(/\//g, '\\') : dir
  const launcher = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'

  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcher, [normalizedDir], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    // 就绪即返回，不等退出码（见上文平台约束）。
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
