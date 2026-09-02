import type { GitOptions, OperationResult } from '../types/index.js'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { join, resolve } from 'pathe'

const execFileAsync = promisify(execFile)

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { stderr?: unknown, message?: unknown }
    return String(value.stderr ?? value.message ?? error).trim()
  }
  return String(error).trim()
}

export async function git(args: string[], cwd: string, options: GitOptions = {}): Promise<OperationResult<{ out: string }>> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
      signal: options.signal,
    })
    return { ok: true, out: String(stdout).trim() }
  }
  catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/**
 * 把补丁以临时文件形式喂给 `git apply`。async execFile 不支持 stdin 的 `input` 选项，
 * 而 binary patch（`--binary`）是 ASCII(base85) 编码，UTF-8 写盘无损；临时文件放在系统
 * 临时目录，避免污染目标仓库的工作区状态。
 * @param {string} cwd
 * @param {string} patch
 * @param {GitOptions} [options]
 * @returns {Promise<OperationResult<{ out: string }>>} out 为 `git apply` 的输出（去尾空白）
 */
async function applyPatchArchive(cwd: string, patch: string, options: GitOptions = {}): Promise<OperationResult<{ out: string }>> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'dsh-worktree-'))
    const patchPath = join(dir, 'staged.patch')
    // git() 捕获侧对 stdout 做了 trim()（补丁末尾换行被剥掉），git apply 要求 hunk 末尾
    // 行有换行终止，否则报 "corrupt patch at line N"。这里补回一个末尾换行。
    const archive = patch.endsWith('\n') ? patch : `${patch}\n`
    await writeFile(patchPath, archive, 'utf8')
    return await git(['apply', '--cached', '--binary', '--whitespace=nowarn', patchPath], cwd, options)
  }
  catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  finally {
    if (dir)
      await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 捕获 index 相对 HEAD 的暂存改动（binary patch）。用它而非 `git stash` 在工作树与
 * 本地仓库之间搬运暂存内容：stash 是仓库级共享状态，一次 pop 进错 worktree 会互相
 * 污染；diff/apply 只动 index 与受影响文件，且完全不触碰源侧工作区。
 * @param {string} cwd
 * @param {GitOptions} [options]
 * @returns {Promise<OperationResult<{ patch: string }>>} patch 为空串表示无暂存内容
 */
export async function stagedPatch(cwd: string, options: GitOptions = {}): Promise<OperationResult<{ patch: string }>> {
  // --no-renames 避免 rename 检测：搬迁语义下 delete+add 比 rename 更稳，且 apply 无需
  // 精确匹配 rename 的相似度计算。
  const result = await git(['diff', '--cached', '--binary', '--no-renames'], cwd, options)
  if (!result.ok)
    return result
  return { ok: true, patch: result.out }
}

/**
 * 在目标工作目录重建源侧暂存状态：先把 staged patch 应用到 index（不碰工作区），再仅
 * 对 patch 涉及的路径把工作区同步为 index 内容（新增/修改写盘、删除移除文件），使目标
 * `git status` 的暂存/未暂存分布与源侧一致。绝不触碰 patch 之外的路径，避免覆盖目标
 * 目录里用户已有的未提交改动。
 * @param {string} cwd
 * @param {string} patch
 * @param {GitOptions} [options]
 * @returns {Promise<OperationResult<{ out: string }>>} out 为受影响路径列表（换行分隔）
 */
export async function applyStagedPatch(cwd: string, patch: string, options: GitOptions = {}): Promise<OperationResult<{ out: string }>> {
  if (!patch.trim())
    return { ok: true, out: '' }
  const applied = await applyPatchArchive(cwd, patch, options)
  if (!applied.ok)
    return applied
  // apply 后 index 相对 HEAD 的差异就是被携带的路径集合（与源侧暂存文件一致）。
  const names = await git(['diff', '--cached', '--name-only', '-z'], cwd, options)
  if (!names.ok)
    return names
  const paths = names.out.split('\0').filter(Boolean)
  if (paths.length === 0)
    return { ok: true, out: '' }

  // 仍在 index 中的路径（新增/修改）：checkout-index 从 index 写盘；已从 index 删除的
  // 路径（暂存删除）：移除工作区残留文件，避免其变成 untracked 扰乱状态。
  const trackedRaw = await git(['ls-files', '-z', '--', ...paths], cwd, options)
  if (!trackedRaw.ok)
    return trackedRaw
  const tracked = new Set(trackedRaw.out.split('\0').filter(Boolean))
  const inIndex = paths.filter(path => tracked.has(path))
  const deleted = paths.filter(path => !tracked.has(path))
  if (inIndex.length > 0) {
    const written = await git(['checkout-index', '-f', '--', ...inIndex], cwd, options)
    if (!written.ok)
      return written
  }
  for (const relative of deleted) {
    try {
      await rm(join(cwd, relative), { force: true })
    }
    catch {
      /* 文件本就不存在时忽略 */
    }
  }
  return { ok: true, out: paths.join('\n') }
}

/**
 * 把源工作目录的暂存内容完整搬到目标工作目录（创建：源仓库→新工作树；检出：工作树→
 * 本地仓库）。只搬运 index 状态；未暂存与未跟踪改动按设计不携带。
 * @param {string} sourceCwd
 * @param {string} targetCwd
 * @param {GitOptions} [options]
 * @returns {Promise<OperationResult<{ carried: string[] }>>} carried 为被携带的路径列表
 */
export async function carryStagedChanges(sourceCwd: string, targetCwd: string, options: GitOptions = {}): Promise<OperationResult<{ carried: string[] }>> {
  const captured = await stagedPatch(sourceCwd, options)
  if (!captured.ok)
    return captured
  if (!captured.patch.trim())
    return { ok: true, carried: [] }
  const applied = await applyStagedPatch(targetCwd, captured.patch, options)
  if (!applied.ok)
    return applied
  return { ok: true, carried: applied.out ? applied.out.split('\n').filter(Boolean) : [] }
}

export async function gitToplevel(path: string): Promise<string | null> {
  const result = await git(['rev-parse', '--show-toplevel'], path)
  return result.ok ? resolve(result.out) : null
}

export function projectDirname(projectPath: string): string {
  return workspaceTitleOf(resolve(projectPath))
}

export async function shortHead(worktreePath: string): Promise<string> {
  const result = await git(['rev-parse', '--short', 'HEAD'], worktreePath)
  return result.ok ? result.out : '?'
}

export async function headSubject(worktreePath: string): Promise<string> {
  const result = await git(['log', '-1', '--pretty=%s'], worktreePath)
  return result.ok && result.out ? result.out : '?'
}
