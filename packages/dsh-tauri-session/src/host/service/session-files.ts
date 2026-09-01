/**
 * session-files.ts — 会话定位与持久化文件域：从 ctx 找会话对象、读其 cwd，
 * 以及按会话 id 定位/删除磁盘上的会话数据目录。
 *
 * 删除授权边界：
 *   - id → 编码（encodeSessionId）与 dsh 宿主 JSONL 持久化后端的编码完全一致；
 *   - 路径必须严格位于 sessionsRoot 之内（isWithinSessionsRoot），防 `..`/绝对路径逃逸；
 *   - 物理删除是 best-effort（找不到就跳过），但抛出异常时必须由调用方中止流程。
 */

import type { HostContext, SessionLike } from '../types/index.js'
import { readdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'pathe'

/** 查找会话对象（host ctx.sessions）。 */
export function findSession(ctx: HostContext, sessionId: string): SessionLike | undefined {
  if (!sessionId)
    return undefined
  return (ctx.sessions?.get?.(sessionId) as SessionLike | undefined)
    ?? (ctx.sessions?.list?.() as SessionLike[] | undefined)?.find((session: SessionLike) => session.id === sessionId)
}

/** 会话工作目录（header.cwd）。 */
export function sessionCwd(session: SessionLike | undefined): string | undefined {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

/** 判断一个路径是否是存在的目录。 */
function isDir(path: string): boolean {
  try {
    return readdirSync(path).length >= 0
  }
  catch {
    return false
  }
}

/** 规范化路径是否严格位于 sessionsRoot 之内（防 `..`/绝对路径逃逸）。 */
export function isWithinSessionsRoot(sessionsRoot: string, candidate: string): boolean {
  const root = resolve(sessionsRoot)
  const target = resolve(candidate)
  return target === root || target.startsWith(`${root}${sep}`)
}

/** Encode the session id exactly as the JSONL persistence backend does. */
export function encodeSessionId(id: string): string {
  if (id === '.')
    return '~002E'
  if (id === '..')
    return '~002E~002E'
  let encoded = ''
  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index)
    const char = String.fromCharCode(code)
    encoded += char !== '~' && /^[\w.-]$/.test(char)
      ? char
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}

/**
 * 物理删除一个会话的持久化目录（best-effort，找不到就跳过）。
 * dsh 宿主没有公开的「删除会话」API，会话数据存放在 `$DSH_HOME/sessions/<group>/session-<id>/`；
 * 这里做有界扫描（深度 2）命中 `session-<id>` 目录后删除。删除后宿主重启时
 * 会从持久化重建会话索引，该会话从工作区/归档中彻底消失。
 * @returns 是否实际删除了目录。
 */
export function removeSessionDataDir(dshHome: string, sessionId: string): boolean {
  const sessionsRoot = join(dshHome, 'sessions')
  // DSH versions use either the raw id or the legacy `session-<id>` directory name.
  const encodedId = encodeSessionId(sessionId)
  const markers = [encodedId, `session-${sessionId}`, sessionId]
  // 一级：sessions/<id> or sessions/session-<id>
  for (const marker of markers) {
    const direct = join(sessionsRoot, marker)
    if (isWithinSessionsRoot(sessionsRoot, direct) && isDir(direct)) {
      rmSync(direct, { recursive: true, force: true })
      return true
    }
  }
  // 二级：sessions/<group>/session-<id>
  let groups: string[] = []
  try {
    groups = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  }
  catch {
    return false
  }
  for (const group of groups) {
    for (const marker of markers) {
      const nested = join(sessionsRoot, group, marker)
      if (isWithinSessionsRoot(sessionsRoot, nested) && isDir(nested)) {
        rmSync(nested, { recursive: true, force: true })
        return true
      }
    }
  }
  return false
}
