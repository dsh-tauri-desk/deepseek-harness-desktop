/**
 * operation.ts — 工作树生命周期操作：创建 / 检出本地 / 放弃，以及绑定的
 * 磁盘定位（hash / 路径 / key 计算）。
 *
 * 规则（与宿主侧 AGENTS.md 一致）：
 *   - 破坏性 Git 操作必须检查每一步结果，失败时保留可恢复的 binding/ledger；
 *   - 绝不静默覆盖用户已有分支或未提交改动；
 *   - ledger 的 load-modify-save 在单操作内完成，两个并发操作由路由层串行约束。
 */

import type {
  Binding,
  CheckoutOptions,
  EnsureOptions,
  HostContext,
  OperationResult,
  WorktreeParams,
} from '../types/index.js'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'pathe'
import { WORKTREE_BRANCH_NAME_PATTERN } from '../constants/index.js'
import { loadLedger, saveLedger } from '../storage/index.js'
import {
  applyStagedPatch,
  carryStagedChanges,
  git,
  gitToplevel,
  headSubject,
  projectDirname,
  shortHead,
  stagedPatch,
} from './git.js'

/** 计算 hash：项目路径 + 会话 ID → sha256 前 12 位。 */
export function computeHash(projectPath: string, sessionId: string): string {
  return createHash('sha256').update(`${projectPath}:${sessionId}`).digest('hex').slice(0, 12)
}

/** 工作树落盘目录：`<home>/worktrees/<hash>/<dirname>`。 */
export function worktreePath(worktreesRoot: string, hash: string, dirname: string): string {
  return join(worktreesRoot, 'worktrees', hash, dirname)
}

/** 工作树展示用相对标识 `[hash]/[dirname]`。 */
export function worktreeKey(hash: string, dirname: string): string {
  return `${hash}/${dirname}`
}

/**
 * 创建工作树（幂等）：已存在则复用并返回已存在标记。
 * @param ctx 宿主根上下文（agents/workspaceRegistry 与 agents.create 流程在 handoff.ts 使用）
 * @param worktreesRoot 工作树根目录
 * @param projectPath 源项目路径（须为 git 仓库顶层）
 * @param sessionId 目标（工作树）会话 id
 * @param opts 创建选项（signal / sourceSessionId / branchName / carryStaged）
 * @returns 创建/复用结果
 */
export async function ensureWorktree(
  ctx: HostContext,
  worktreesRoot: string,
  projectPath: string,
  sessionId: string,
  opts: EnsureOptions = {},
): Promise<OperationResult<{ binding: Binding, log: string[], existed: boolean }>> {
  // ctx 仅为工具/路由层统一签名保留（本实现只依赖 worktreesRoot 与 opts）。
  void ctx
  const root = await gitToplevel(projectPath)
  if (!root)
    return { ok: false, error: `项目路径不是 git 仓库顶层：${projectPath}` }

  const hash = computeHash(projectPath, sessionId)
  const dirname = projectDirname(projectPath)
  const path = worktreePath(worktreesRoot, hash, dirname)

  const ledger = await loadLedger(worktreesRoot)
  const existing = ledger[sessionId]
  if (existing && existsSync(existing.worktreePath)) {
    return { ok: true, binding: existing, existed: true, log: [] }
  }

  // 若目录残留但 git 未注册（被打断），先清掉再重建。
  if (existsSync(path)) {
    await git(['worktree', 'prune'], root)
  }

  const requestedBranch = String(opts.branchName ?? '').trim()
  if (requestedBranch && !WORKTREE_BRANCH_NAME_PATTERN.test(requestedBranch)) {
    return { ok: false, error: `非法分支名：${requestedBranch}` }
  }
  const branchName = requestedBranch
    ? (requestedBranch.startsWith('dsh/') ? requestedBranch : `dsh/${requestedBranch.replace(/^\/+/, '')}`)
    : ''
  if (branchName === 'dsh/')
    return { ok: false, error: '分支名不能为空' }
  if (branchName) {
    const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], root, { signal: opts.signal })
    if (exists.ok)
      return { ok: false, error: `分支已存在：${branchName}` }
  }

  const log = ['Starting worktree creation']
  const addArgs = branchName
    ? ['worktree', 'add', '-b', branchName, path, 'HEAD']
    : ['worktree', 'add', '--detach', path, 'HEAD']
  const add = await git(addArgs, root, { signal: opts.signal })
  if (!add.ok)
    return { ok: false, error: `创建工作树失败：${add.error}` }

  // 可选携带源仓库暂存内容：工作树默认从 HEAD 干净检出，用户已暂存的改动不会出现；
  // carryStaged 打开时把 index 状态搬进新工作树（只搬已暂存，未暂存/未跟踪不携带）。
  // 失败则回滚刚创建的 worktree，避免留下「创建成功但内容不完整」的半成品。
  if (opts.carryStaged === true) {
    const carried = await carryStagedChanges(root, path, { signal: opts.signal })
    if (!carried.ok) {
      await git(['worktree', 'remove', '--force', path], root, { signal: opts.signal })
      await git(['worktree', 'prune'], root, { signal: opts.signal })
      return { ok: false, error: `携带暂存内容失败，工作树已回滚：${carried.error}` }
    }
    if (carried.carried.length > 0)
      log.push(`Carried staged changes (${carried.carried.length} file(s)) from the source repository`)
  }

  // UI 预选流程保持 detached；Agent 工具提供 branch_name 时直接在 dsh/* 分支工作。
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], path)
  const activeBranch = head.ok ? head.out : (branchName || '(detached)')
  log.push(branchName
    ? `Preparing worktree (branch ${branchName})`
    : `Preparing worktree (detached HEAD ${await shortHead(path)})`)
  log.push(`HEAD is now at ${await shortHead(path)} ${await headSubject(path)}`)
  log.push(`Worktree created at ${path}`)

  const binding = {
    sessionId,
    sourceSessionId: opts.sourceSessionId || sessionId,
    hash,
    dirname,
    worktreePath: path,
    projectPath: root,
    branchName: activeBranch,
    ownsBranch: Boolean(branchName),
    createdAt: new Date().toISOString(),
    log,
  }
  ledger[sessionId] = binding
  await saveLedger(worktreesRoot, ledger)

  // 不注册成普通 DSH Workspace：否则「新建会话」会复用 blank worktree 会话，
  // 造成默认进入工作树。隔离会话直接以 sessions.create({ cwd }) 绑定此路径。

  return { ok: true, binding, log, existed: false }
}

/** 解析工作树绑定（兼容 sessionId 或 worktreeHashDirname 定位）。 */
export async function resolveBinding(worktreesRoot: string, sessionId?: string, key?: string): Promise<{ binding: Binding | null }> {
  const ledger = await loadLedger(worktreesRoot)
  if (sessionId && ledger[sessionId])
    return { binding: ledger[sessionId] }
  if (key) {
    for (const binding of Object.values(ledger)) {
      if (binding.hash && binding.dirname && `${binding.hash}/${binding.dirname}` === key) {
        return { binding }
      }
    }
  }
  return { binding: null }
}

/** 清理旧版本创建的普通 Workspace 注册；仅注销记录，不删除目录或会话。 */
export async function unregisterWorktreeWorkspace(ctx: HostContext, path: string): Promise<void> {
  try {
    const workspace = await ctx.workspaceRegistry.resolveByPath(path)
    if (workspace?.id)
      await ctx.workspaceRegistry.delete(workspace.id)
  }
  catch {
    /* 未注册或路径已不存在时无需处理 */
  }
}

/**
 * 检出本地：在工作树分支保留改动，本地仓库创建/切换用户指定的分支。
 *
 * 检出语义（已与用户确认）：「检出本地」= 在工作树分支上保留全部改动，在本地仓库
 * 创建/切换到 `dsh/<branch>` 分支，Agent 继续在本地仓库工作；主分支不受影响。
 * @param ctx 宿主根上下文
 * @param worktreesRoot 工作树根目录
 * @param params 检出参数（worktree_hash_dirname / sessionId / branch_name）
 * @param opts 检出选项（signal / carryStaged / beforeRemove 会话交接钩子）
 * @returns 检出结果
 */
export async function checkoutToLocal(
  ctx: HostContext,
  worktreesRoot: string,
  params: WorktreeParams,
  opts: CheckoutOptions = {},
): Promise<OperationResult<{ branch: string, projectPath: string, worktreePath: string }>> {
  const { binding } = await resolveBinding(worktreesRoot, params.sessionId, params.worktreeHashDirname)
  if (!binding)
    return { ok: false, error: `未找到绑定的工作树` }
  if (!existsSync(binding.worktreePath))
    return { ok: false, error: `工作树目录不存在：${binding.worktreePath}` }

  const root = binding.projectPath
  // 本地分支名完全使用调用方输入；UI 默认填 `dsh/`，但用户可删除该前缀。
  const branch = String(params.branch_name ?? binding.branchName ?? '').trim()
  if (!branch || branch.endsWith('/'))
    return { ok: false, error: `分支名不能为空或以 / 结尾：${branch}` }
  const validBranch = await git(['check-ref-format', '--branch', branch], root, { signal: opts.signal })
  if (!validBranch.ok)
    return { ok: false, error: `非法分支名：${branch}` }

  // 1) 在改动 ref 前完成安全预检。主工作区必须干净，避免 git checkout 把本地改动
  //    静默带到功能分支；隔离工作树仅允许 committed 内容和显式携带的 staged 内容。
  const mainStatus = await git(['status', '--porcelain=v1'], root, { signal: opts.signal })
  if (!mainStatus.ok)
    return { ok: false, error: `读取本地主工作区状态失败：${mainStatus.error}` }
  if (mainStatus.out)
    return { ok: false, error: '本地主工作区存在未提交改动；请先提交或清理后再检出工作树' }
  const worktreeStatus = await git(['status', '--porcelain=v1'], binding.worktreePath, { signal: opts.signal })
  if (!worktreeStatus.ok)
    return { ok: false, error: `读取隔离工作树状态失败：${worktreeStatus.error}` }
  const dirtyRows = worktreeStatus.out.split('\n').filter(Boolean)
  const unsupportedRows = dirtyRows.filter(row => !/^[ACDMRT] /.test(row))
  if (unsupportedRows.length > 0)
    return { ok: false, error: '隔离工作树存在未暂存或未跟踪改动；请先提交这些改动再检出，避免删除工作树时丢失内容' }
  if (dirtyRows.length > 0 && opts.carryStaged !== true)
    return { ok: false, error: '隔离工作树存在已暂存改动；请启用 carry_staged 或先提交这些改动再检出' }

  const worktreeHead = await git(['rev-parse', 'HEAD'], binding.worktreePath, { signal: opts.signal })
  if (!worktreeHead.ok)
    return { ok: false, error: `读取工作树 HEAD 失败：${worktreeHead.error}` }
  const prev = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root, { signal: opts.signal })
  if (!prev.ok)
    return { ok: false, error: '本地主工作区当前处于 detached HEAD；请先切换到本地分支再检出工作树' }
  const prevBranch = prev.out
  // 显式标注联合类型，保证 `ok` 判别后两端各自可访问 error/patch（含 ok:boolean 的
  // 泛化联合无法据此收窄到 error 分支）。
  const carriedPatch: OperationResult<{ patch: string }> = opts.carryStaged === true
    ? await stagedPatch(binding.worktreePath, { signal: opts.signal })
    : { ok: true, patch: '' }
  if (!carriedPatch.ok)
    return { ok: false, error: `读取工作树暂存内容失败：${carriedPatch.error}` }

  // 2) Agent 创建的工作树已经拥有其功能分支。先把工作树 detach 以释放该分支，再在
  //    本地主工作区切到同一个现有分支；不能把“分支已存在”误判成冲突并复制第二个分支。
  //    其他已存在分支仍安全拒绝，绝不静默重置用户分支指针。
  const branchRef = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root, { signal: opts.signal })
  const handsOffOwnedBranch = binding.ownsBranch && binding.branchName === branch
  let detachedOwnedBranch = false
  let createdBranch = false
  if (handsOffOwnedBranch) {
    if (!branchRef.ok)
      return { ok: false, error: `工作树拥有的本地分支不存在，拒绝重建以避免覆盖状态：${branch}` }
    if (branchRef.out !== worktreeHead.out)
      return { ok: false, error: `工作树 HEAD 与其本地分支指针不一致，拒绝检出：${branch}` }
    const activeBranch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], binding.worktreePath, { signal: opts.signal })
    if (!activeBranch.ok || activeBranch.out !== branch)
      return { ok: false, error: `工作树未签出其记录的本地分支，拒绝检出：${branch}` }
    const detached = await git(['checkout', '--detach'], binding.worktreePath, { signal: opts.signal })
    if (!detached.ok)
      return { ok: false, error: `释放工作树分支失败：${detached.error}` }
    detachedOwnedBranch = true
  }
  else {
    if (branchRef.ok)
      return { ok: false, error: `本地分支已存在且不属于当前工作树，为避免覆盖其提交而拒绝检出：${branch}` }
    const created = await git(['branch', branch, worktreeHead.out], root, { signal: opts.signal })
    if (!created.ok)
      return { ok: false, error: `创建本地分支失败：${created.error}` }
    createdBranch = true
  }

  const restoreSourceBranch = async (): Promise<string> => {
    if (!detachedOwnedBranch)
      return ''
    const restored = await git(['checkout', branch], binding.worktreePath)
    return restored.ok ? '' : `；工作树分支自动恢复失败：${restored.error}`
  }
  const removeCreatedBranch = async (): Promise<string> => {
    if (!createdBranch)
      return ''
    const removed = await git(['branch', '-D', branch], root)
    return removed.ok ? '' : `；新建分支自动清理失败：${removed.error}`
  }
  const rollbackHandoff = async (resetTarget = false): Promise<string> => {
    const failures: string[] = []
    if (resetTarget) {
      const reset = await git(['reset', '--hard', 'HEAD'], root)
      if (!reset.ok)
        failures.push(`清理目标分支暂存状态失败：${reset.error}`)
    }
    const switchedBack = await git(['checkout', prevBranch], root, { signal: opts.signal })
    if (!switchedBack.ok) {
      failures.push(`恢复本地主分支失败：${switchedBack.error}`)
    }
    else {
      const sourceRecovery = detachedOwnedBranch ? await restoreSourceBranch() : await removeCreatedBranch()
      if (sourceRecovery)
        failures.push(sourceRecovery.replace(/^；/, ''))
    }
    return failures.length > 0 ? `；${failures.join('；')}` : ''
  }

  // 3) 本地主工作区切到移交或新建的分支。失败时恢复原工作树的分支占用，或清理本次
  //    新建的分支，保证重试不会因残留状态再次失败。
  const check = await git(['checkout', branch], root, { signal: opts.signal })
  if (!check.ok) {
    const recovery = detachedOwnedBranch ? await restoreSourceBranch() : await removeCreatedBranch()
    return { ok: false, error: `切换到本地分支失败：${check.error}${recovery}` }
  }

  // 3.5) carryStaged：把工作树已暂存内容应用到本地检出，只动补丁涉及的路径，不覆盖
  //      本地其他未提交改动。失败时回滚到检出前分支并保留工作树，便于重试。
  if (carriedPatch.patch.trim()) {
    const applied = await applyStagedPatch(root, carriedPatch.patch, { signal: opts.signal })
    if (!applied.ok) {
      const recovery = await rollbackHandoff(true)
      return { ok: false, error: `携带暂存内容失败，工作树已保留：${applied.error}${recovery}` }
    }
  }

  // Preserve the worktree until the local session has been created successfully.
  if (opts.beforeRemove) {
    const prepared = await opts.beforeRemove({ branch, projectPath: root, worktreePath: binding.worktreePath })
    if (!prepared.ok) {
      const recovery = await rollbackHandoff(Boolean(carriedPatch.patch.trim()))
      return { ok: false, error: `Failed to create the local handback session; the worktree was preserved: ${prepared.error}${recovery}` }
    }
  }

  // 4) 注销旧版本可能创建的普通 Workspace 记录，再移除工作树。
  await unregisterWorktreeWorkspace(ctx, binding.worktreePath)
  const removed = await git(['worktree', 'remove', '--force', binding.worktreePath], root, { signal: opts.signal })
  if (!removed.ok)
    return { ok: false, error: `删除工作树失败，绑定已保留以便重试：${removed.error}` }
  await git(['worktree', 'prune'], root, { signal: opts.signal })

  // 5) 解除绑定。
  const ledger = await loadLedger(worktreesRoot)
  delete ledger[binding.sessionId]
  await saveLedger(worktreesRoot, ledger)

  return { ok: true, branch, projectPath: root, worktreePath: binding.worktreePath }
}

/**
 * 放弃更改：删除工作树并解除绑定（会话保留）。
 * @param ctx 宿主根上下文
 * @param worktreesRoot 工作树根目录
 * @param params 放弃参数（worktree_hash_dirname / sessionId）
 * @param opts 选项（signal）
 * @returns 放弃结果
 */
export async function discardWorktree(
  ctx: HostContext,
  worktreesRoot: string,
  params: WorktreeParams,
  opts: { signal?: AbortSignal } = {},
): Promise<OperationResult<{ worktreePath: string }>> {
  const { binding } = await resolveBinding(worktreesRoot, params.sessionId, params.worktreeHashDirname)
  if (!binding)
    return { ok: false, error: `未找到绑定的工作树` }

  await unregisterWorktreeWorkspace(ctx, binding.worktreePath)
  if (existsSync(binding.worktreePath)) {
    const removed = await git(['worktree', 'remove', '--force', binding.worktreePath], binding.projectPath, { signal: opts.signal })
    if (!removed.ok)
      return { ok: false, error: `删除工作树失败，绑定已保留以便重试：${removed.error}` }
    await git(['worktree', 'prune'], binding.projectPath, { signal: opts.signal })
  }
  // create_worktree(branch_name) 新建的 dsh/* 分支属于临时工作树；放弃时一并删除。
  // UI detached 流程和旧 ledger 没有 ownsBranch，不碰其任何本地分支。
  if (binding.ownsBranch && binding.branchName) {
    await git(['branch', '-D', binding.branchName], binding.projectPath, { signal: opts.signal })
  }

  const ledger = await loadLedger(worktreesRoot)
  delete ledger[binding.sessionId]
  await saveLedger(worktreesRoot, ledger)

  return { ok: true, worktreePath: binding.worktreePath }
}
