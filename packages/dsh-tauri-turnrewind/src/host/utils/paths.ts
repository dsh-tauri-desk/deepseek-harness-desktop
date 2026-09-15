import type { PathSafety } from './paths.types'
import { lstatSync, rmdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'pathe'
import { REASON_NON_EMPTY_DIR, REASON_UNSAFE_PATH } from '../config/constants'

/**
 * 恢复路径的安全解析与删除。
 *
 * 撤销是唯一会写用户工作区的动作，因此路径判定必须在词法之上再加一层文件系统事实校验：
 * `sub/file.txt` 词法上在工作区内，但 `sub` 若是指向外部的符号链接或 Windows junction，
 * `git checkout` / `unlink` 就会写到工作区外面去。
 *
 * 只检查**父级**（目标自身是符号链接时 unlink/覆盖只作用于链接本身，不会穿透），
 * 且用 `lstat` 而非 `existsSync` 预检（后者对悬空链接返回 false）。
 */

/** 词法包含检查：越界（绝对路径、`..` 逃逸、NUL）返回 null。 */
export function resolveInsideWorkspace(worktree: string, path: string): string | null {
  if (path.length === 0 || path.includes('\0') || isAbsolute(path))
    return null
  const absolute = resolve(worktree, path)
  const rel = relative(worktree, absolute)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel))
    return null
  return absolute
}

/** 校验某个已解析的工作区内绝对路径：任一路径组件（除目标自身）都不得是符号链接/junction。 */
export function assertSafeParents(worktree: string, absolutePath: string): PathSafety {
  const root = resolve(worktree)
  const rel = relative(root, absolutePath)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel))
    return { ok: false, reason: REASON_UNSAFE_PATH }
  const segments = rel.split('/')
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    let stats
    try {
      stats = lstatSync(current)
    }
    catch {
      // 父级还不存在（A 型新增文件的常见情形）：恢复时由 git/写盘自行创建，安全。
      return { ok: true }
    }
    if (stats.isSymbolicLink() || !stats.isDirectory())
      return { ok: false, reason: REASON_UNSAFE_PATH }
  }
  return { ok: true }
}

/**
 * 撤销 A 型（本 turn 新增）路径：文件或符号链接直接删除；空目录删除；
 * **非空目录拒绝**（递归删除可能毁掉本 turn 从未碰过、且不在快照里的文件）。
 */
export function removeCreatedPath(absolutePath: string): PathSafety {
  let stats
  try {
    stats = lstatSync(absolutePath)
  }
  catch {
    // 已经不在了：按「已删除」结算，不算失败。
    return { ok: true }
  }
  try {
    if (stats.isDirectory()) {
      rmdirSync(absolutePath)
      return { ok: true }
    }
    unlinkSync(absolutePath)
    return { ok: true }
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT')
      return { ok: true }
    if (stats.isDirectory())
      return { ok: false, reason: REASON_NON_EMPTY_DIR }
    return { ok: false, reason: `${REASON_UNSAFE_PATH}: ${String((error as Error)?.message ?? error)}` }
  }
}
