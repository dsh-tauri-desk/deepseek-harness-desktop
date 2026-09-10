/**
 * host/service/git.ts — git 子进程封装。
 *
 * 两种调用面严格区分，二者都不抛异常（失败一律返回 `{ ok: false }`），
 * 让上层能按「捕获失败不得打断 Agent turn」的语义处理：
 *   - `gitInRepo`：在**用户仓库**里执行**只读**探测（rev-parse / rev-parse --git-common-dir）。
 *     绝不执行任何写命令——本插件对用户仓库只读是硬契约（有零污染测试钉住）。
 *   - `gitInSnapshot`：在**私有快照仓**里执行读写（add / write-tree / commit-tree /
 *     update-ref / diff / ls-tree / checkout / cat-file / hash-object）。所有写操作都落
 *     在私有仓与私有 index 上，用户仓库的 HEAD / 分支 / index / stash 不受影响。
 */

import type { GitResult, SnapshotStore } from '../types'
import { execFile } from 'node:child_process'
import process from 'node:process'
import { GIT_TIMEOUT_MS } from '../constants'

/** 单次 git 调用的可选项。 */
export interface GitRunOptions {
  /** 追加/覆盖的环境变量。 */
  env?: Record<string, string>
  /** 墙钟超时；缺省 5 分钟。 */
  timeoutMs?: number
  /**
   * 写进子进程 stdin 的内容（缺省立即关闭 stdin）。
   * 只给 `check-ignore --stdin` 这类「路径从 stdin 读」的命令用：路径条数不受
   * Windows argv 上限约束。
   */
  input?: string
}

/** git 输出缓冲上限：快照/差异输出可能很大，但仍需有界。 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024

function execGit(cwd: string, args: string[], options: GitRunOptions): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: GIT_MAX_BUFFER,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || error.message || error).trim()
          // code 是「诊断」而非「结果」：ENOENT 表示 PATH 上没有 git，
          // 与「目录不是 Git 仓库」是两种完全不同的用户指引，必须分开上报。
          const code = (error as NodeJS.ErrnoException).code
          // stdout 在失败分支同样要回传：见 types 里 GitResult 的注释。
          resolve({ ok: false, error: message, out: String(stdout ?? ''), ...(typeof code === 'string' ? { code } : {}) })
          return
        }
        resolve({ ok: true, out: String(stdout ?? '') })
      },
    )
    // execFile 默认给 stdin 开管道，而子进程往往在写入前就已退出：Linux 上那次写入会
    // 以 **未处理的 EPIPE** 冒泡（CI 稳定复现；Windows 管道语义不同未触发）。
    // 这里显式吞掉 stdin 的错误事件——真正的失败仍然由上面的回调统一上报。
    child.stdin?.on('error', () => {})
    // 需要喂 stdin 的命令（check-ignore --stdin）一次写完并关闭；其余命令不读 stdin，
    // 参数全走 argv，保持原先的「空 end」形态（见上一条：Linux 上写空串也可能踩 EPIPE）。
    if (options.input === undefined)
      child.stdin?.end()
    else
      child.stdin?.end(options.input)
  })
}

/** 在私有快照仓中执行（git-dir = 私有仓，work-tree = 会话工作区，cwd = 工作区）。 */
export function gitInSnapshot(store: SnapshotStore, args: string[], options: GitRunOptions = {}): Promise<GitResult> {
  return execGit(store.worktree, ['--git-dir', store.gitDir, '--work-tree', store.worktree, ...args], options)
}

/** 在用户仓库中执行只读探测（不覆盖 git-dir，由 git 自行发现仓库）。 */
export function gitInRepo(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitResult> {
  return execGit(cwd, args, options)
}

/** 解析源仓库的 common dir（用于同步 `.git/info/exclude`）；失败返回 null。 */
export async function resolveSourceCommonDir(worktree: string): Promise<string | null> {
  const result = await gitInRepo(worktree, ['rev-parse', '--git-common-dir'])
  if (!result.ok)
    return null
  const value = result.out.trim()
  if (value.length === 0)
    return null
  // `--git-common-dir` 可能是相对 worktree 的路径（如 `.git`）。
  return value
}

/**
 * 回收私有仓里不可达的 loose object（`git prune --expire=now`）。
 *
 * 来源：`git add --all` 每次都会把变化后的内容写成 blob，而运行中的实时读数每 1.5s
 * 就跑一次——中间版本的 blob 没有任何 ref 可达。我们又把 `gc.auto` 关成了 0
 * （避免后台回收与撤销抢锁），所以必须显式回收，否则私有仓只涨不降。
 * 只删不可达对象，`refs/turnrewind/*` 链上的对象不受影响。
 *
 * @param store - 私有快照仓。
 * @returns 是否执行成功（失败只影响体积，调用方按 best-effort 处理）。
 */
export async function pruneLooseObjects(store: SnapshotStore): Promise<boolean> {
  const result = await gitInSnapshot(store, ['prune', '--expire=now'])
  return result.ok
}
