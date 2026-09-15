/**
 * host/utils/workspace.ts — 工作区路径归一与系统目录判定的纯函数。
 *
 * 快照域是 worktree 根：会话 cwd 是子目录时归并到根，同一仓库共享一个快照域，
 * 绝不使用 `process.cwd()` 兜底（宿主进程的工作目录未必是会话工作区）。
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { resolve } from 'pathe'

/** 解析为磁盘上的真实路径（符号链接/短名归一）；路径不存在时退回 resolve 结果。 */
export function canonicalWorkspacePath(target: string): string {
  const resolved = resolve(target)
  try {
    // `.native` 是 Windows 的硬要求：libuv 的 JS-path realpath 不展开 8.3 短名，
    // 而 git 的 --show-toplevel 输出长名，不统一会让同一工作区产生两种拼写。
    const native = process.platform === 'win32' ? resolved.replaceAll('/', '\\') : resolved
    return resolve(realpathSync.native(native))
  }
  catch {
    return resolved
  }
}

/** 快照域的键：规范化后再做大小写折叠（Windows 上 `C:\Repo` 与 `c:\repo` 必须同域）。 */
export function workspaceKey(target: string): string {
  const canonical = canonicalWorkspacePath(target)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/** 工作区键的短哈希（私有快照仓目录名）。 */
export function workspaceHash(target: string): string {
  return createHash('sha256').update(workspaceKey(target)).digest('hex').slice(0, 24)
}

/** 是否为系统级敏感目录（家目录本身、家目录祖先、盘根、UNC 共享根）。 */
export function isSystemSensitivePath(target: string): boolean {
  const raw = target.trim()
  if (raw.length === 0)
    return true
  // 盘根与 UNC 根必须按**原始形态**判定：pathe 会把 `C:\` 解析成 `/C:`，
  // 解析之后再判形态就不可靠了。
  if (/^[a-z]:[\\/]*$/i.test(raw))
    return true
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]*$/.test(raw))
    return true
  const canonical = workspaceKey(raw)
  if (canonical.length === 0)
    return true
  if (/^\/?[a-z]:\/?$/i.test(canonical) || canonical === '/')
    return true
  const home = workspaceKey(homedir())
  if (canonical === home)
    return true
  const homePrefix = canonical.endsWith('/') ? canonical : `${canonical}/`
  return home.startsWith(homePrefix)
}
