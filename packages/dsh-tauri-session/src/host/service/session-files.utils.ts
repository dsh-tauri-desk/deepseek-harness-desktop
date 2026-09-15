import { readdirSync } from 'node:fs'
import { DSH_HOME } from 'dsh-tauri'
import { join, resolve, sep } from 'pathe'
import {
  DOT_DOT_SEGMENT,
  DOT_ESCAPE,
  DOT_SEGMENT,
  SESSION_DIRECTORY_PREFIX,
  SESSION_ID_ESCAPE,
  SESSIONS_DIRECTORY,
} from '../config/constants'

export function sessionsRoot(): string {
  return join(DSH_HOME, SESSIONS_DIRECTORY)
}

/** 规范化路径是否严格位于 root 之内（防 `..` / 绝对路径逃逸）。 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(`${base}${sep}`)
}

/** 与 dsh 宿主 JSONL 持久化后端逐字一致的会话 id 编码。 */
export function encodeSessionId(id: string): string {
  if (id === DOT_SEGMENT)
    return DOT_ESCAPE
  if (id === DOT_DOT_SEGMENT)
    return `${DOT_ESCAPE}${DOT_ESCAPE}`
  let encoded = ''
  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index)
    const char = String.fromCharCode(code)
    encoded += char !== SESSION_ID_ESCAPE && /^[\w.-]$/.test(char)
      ? char
      : `${SESSION_ID_ESCAPE}${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}

/** 读取目录条目；不存在或不可读返回 null。 */
export function readDirectory(path: string): string[] | null {
  try {
    return readdirSync(path)
  }
  catch {
    return null
  }
}

/**
 * 有界扫描（深度 2）定位会话数据目录：一级 `sessions/<marker>`，
 * 二级 `sessions/<group>/<marker>`；marker 依次尝试编码 id / `session-<id>` / 裸 id。
 */
export function findSessionDataDir(root: string, sessionId: string): string | null {
  const markers = [encodeSessionId(sessionId), `${SESSION_DIRECTORY_PREFIX}${sessionId}`, sessionId]
  const candidates = [
    ...markers.map(marker => join(root, marker)),
    ...directoryNames(root).flatMap(group => markers.map(marker => join(root, group, marker))),
  ]
  return candidates.find(candidate => isWithinRoot(root, candidate) && readDirectory(candidate) !== null) ?? null
}

// --- internal ---

function directoryNames(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  }
  catch {
    return []
  }
}
