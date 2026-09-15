import type { OpenSessionDirectoryResult } from './session-files.types'
import { rmSync } from 'node:fs'
import { defineService, openDirectory } from 'dsh-tauri'
import { dirname, resolve } from 'pathe'
import { findSessionDataDir, isWithinRoot, readDirectory, sessionsRoot } from './session-files.utils'

export const sessionFiles = defineService({
  /** 只读定位会话持久化数据目录；未找到返回 null。 */
  load(sessionId: string): string | null {
    if (!sessionId)
      return null
    return findSessionDataDir(sessionsRoot(), sessionId)
  },

  /** 物理删除会话数据目录（找不到即 false），并清理删除后变空的父目录。 */
  remove(sessionId: string): boolean {
    const root = sessionsRoot()
    const dir = sessionId ? findSessionDataDir(root, sessionId) : null
    if (dir === null)
      return false
    rmSync(dir, { recursive: true, force: true })
    pruneEmptyParents(root, dirname(dir))
    return true
  },

  /** 在系统文件管理器中打开会话数据目录（路径由 sessionId 有界解析，不接受客户端路径）。 */
  async open(sessionId: string): Promise<OpenSessionDirectoryResult> {
    const dir = sessionId ? findSessionDataDir(sessionsRoot(), sessionId) : null
    if (dir === null)
      return { ok: false, error: 'session-directory-not-found' }
    try {
      await openDirectory(dir)
    }
    catch {
      return { ok: false, error: 'not-a-directory' }
    }
    return { ok: true }
  },
})

// --- internal ---

function pruneEmptyParents(root: string, parent: string): void {
  if (!isWithinRoot(root, parent) || resolve(parent) === resolve(root))
    return
  const entries = readDirectory(parent)
  if (entries === null || entries.length > 0)
    return
  rmSync(parent, { recursive: true, force: true })
  pruneEmptyParents(root, dirname(parent))
}
