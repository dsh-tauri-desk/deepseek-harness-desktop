/**
 * dsh-tauri-worktree 宿主侧（node half）：会话级 Git Worktree 隔离。
 *
 * 架构（two-half 插件，参照 dsh-tauri 的分层 + worktree-mgr / dsh-worktree-panel 的
 * 宿主技法）：
 *   - 本文件（node half）注册 host 能力：工具、HTTP 路由、系统提示注入；
 *   - `src/client/`（browser half）渲染 UI（模式选择 / 处理状态 / Surface / 弹窗 /
 *     会话列表图标），经 /api/dsh-worktree/* 与本 half 通信。
 *
 * 职责：
 *   1. 根据「项目路径 + 会话 ID」计算唯一 hash，在 `~/.dsh/worktrees/[hash]/[dirname]`
 *      用 `git worktree add --detach` 创建隔离工作树；
 *   2. 维护 per-session 绑定（WeakMap 活对象 + 磁盘 ledger 持久化）；
 *   3. 注册 `create_worktree` / `checkout_worktree` / `discard_worktree` 工具（Agent 自发调用）；
 *   4. 系统提示注入 `is_worktree: true`；
 *   5. 暴露 /api/dsh-worktree/* 给客户端（create / status / checkout / discard）。
 *
 * 检出语义（已与用户确认）：「检出本地」= 在工作树分支上保留全部改动，在本地仓库
 * 创建/切换到 `dsh/<branch>` 分支，Agent 继续在本地仓库工作；主分支不受影响。
 */

import type {
  Binding,
  CheckoutInfo,
  CheckoutOptions,
  EnsureOptions,
  HostContext,
  OperationResult,
  PendingHandoff,
  PluginConfig,
  WorktreeParams,
} from './types.js'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { routeHandler, withConnectionAuth } from 'dsh-tauri'
import { WORKTREE_API_PREFIX, WORKTREE_BRANCH_NAME_PATTERN, WORKTREE_SECTION_ORDER } from './constants.js'
import { applyStagedPatch, carryStagedChanges, git, gitToplevel, headSubject, projectDirname, shortHead, stagedPatch } from './git.js'
import {
  clearPendingCheckoutContext,
  loadCheckoutContextsSync,
  loadLedger,
  loadLedgerSync,
  saveLedger,
  setPendingCheckoutContext,
} from './storage.js'

/** 插件名（诊断元数据，与导出的 name 一致）。 */
export const name = 'dsh-tauri-worktree'

/**
 * 需要的宿主服务：
 *   tools            工具注册表（注册 create_worktree / checkout_worktree / discard_worktree）
 *   systemPrompt     系统提示注入（is_worktree: true）
 *   webServer        HTTP 路由（/api/dsh-worktree/*，客户端经此调用）
 *   sessions         当前会话枚举/查找（绑定工作树）
 *   workspaceRegistry注册工作树为 DSH 工作区（可选，增强归类）
 */
export const inject = ['tools', 'systemPrompt', 'webServer', 'sessions', 'workspaceRegistry', 'agents', 'connection']

/** API 路由前缀（客户端同源 fetch）。 */
export const API_PREFIX = WORKTREE_API_PREFIX

/** 分支名校验（本地分支 dsh/<slug>）。 */
const BRANCH_NAME_RE = WORKTREE_BRANCH_NAME_PATTERN

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

// ---------------------------------------------------------------------------
// 会话解析
// ---------------------------------------------------------------------------

/**
 * 从 ctx 拿到当前会话对象（优先用传入的 session，其次由 id 查 sessions）。
 * @param {any} ctx
 * @param {string} sessionId
 * @returns {any} 会话对象（查不到时 undefined）
 */
function findSession(ctx: HostContext, sessionId: string): any {
  if (!sessionId)
    return undefined
  try {
    return ctx.sessions.get(sessionId) ?? ctx.sessions.list().find((session: any) => session.id === sessionId)
  }
  catch {
    return undefined
  }
}

/**
 * 解析会话的项目根路径：优先 session.header.cwd / session.cwd，其次 workspaceRegistry
 * 按该路径解析工作区根。会话未知或没有任何路径信息时返回 null（调用方按「未知」处理）。
 *
 * 设计原因：新建会话/应用启动存在竞态——客户端列表已出现会话，但宿主 SessionStore 尚无
 * 该会话或 header.cwd 尚未落定。此时绝不能静默回退 process.cwd() 猜测：宿主进程的工作
 * 目录未必是 git 仓库，一旦误判 isGit: false，客户端会永久隐藏工作树模式选择器，直到
 * 刷新后才由真实 header.cwd 纠正。返回 null 让客户端保持默认（git）并稍后重试。
 * @param {any} ctx
 * @param {any} session
 * @returns {Promise<string | null>} 项目根路径；会话无路径信息时返回 null
 */
async function resolveProjectPath(ctx: HostContext, session: any): Promise<string | null> {
  const cwd = typeof session?.header?.cwd === 'string'
    ? session.header.cwd
    : typeof session?.cwd === 'string'
      ? session.cwd
      : ''
  if (!cwd)
    return null
  if (isAbsolute(cwd))
    return cwd
  try {
    const ws = await ctx.workspaceRegistry.resolveByPath(cwd)
    if (ws?.path)
      return ws.path
  }
  catch {
    /* registry 不可用时忽略 */
  }
  return cwd
}

// ---------------------------------------------------------------------------
// 工作树创建
// ---------------------------------------------------------------------------

/**
 * 创建工作树（幂等）：已存在则复用并返回已存在标记。
 * @param {any} ctx
 * @param {string} worktreesRoot
 * @param {string} projectPath
 * @param {string} sessionId
 * @param {{ signal?: AbortSignal, sourceSessionId?: string, branchName?: string }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, binding?: any, log?: string[], existed?: boolean }>} 创建/复用结果
 */
export async function ensureWorktree(
  ctx: HostContext,
  worktreesRoot: string,
  projectPath: string,
  sessionId: string,
  opts: EnsureOptions = {},
): Promise<OperationResult<{ binding: Binding, log: string[], existed: boolean }>> {
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
  if (requestedBranch && !BRANCH_NAME_RE.test(requestedBranch)) {
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

// ---------------------------------------------------------------------------
// 检出本地 / 放弃
// ---------------------------------------------------------------------------

/** 解析工作树绑定（兼容 sessionId 或 worktreeHashDirname 定位）。 */
async function resolveBinding(worktreesRoot: string, sessionId?: string, key?: string): Promise<{ binding: Binding | null }> {
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
async function unregisterWorktreeWorkspace(ctx: HostContext, path: string): Promise<void> {
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
 * @param {any} ctx
 * @param {string} worktreesRoot
 * @param {{ worktree_hash_dirname?: string, sessionId?: string, branch_name?: string }} params
 * @param {{ signal?: AbortSignal, beforeRemove?: (checkout: { branch: string, projectPath: string, worktreePath: string }) => Promise<{ ok: boolean, error?: string }> }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, branch?: string, projectPath?: string, worktreePath?: string }>} 检出结果
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
 * 把工作树会话的完整对话历史带回本地仓库：以工作树会话的全部事件为 seed 创建
 * 继承会话，cwd 指向本地项目路径，并归属源 Workspace。
 *
 * 背景：UI「检出本地」完成后会归档工作树会话。若只是打开 ledger 里的源会话，
 * 界面流程（模式选择器迁移草稿）创建的源会话是空白会话（0 轮对话），归档后用户
 * 会看到「变成新会话、会话信息全部丢失」。本函数在归档前先创建继承会话，保证
 * 检出后仍能看到并继续完整对话。
 *
 * @param {any} ctx
 * @param {string} worktreesRoot
 * @param {string} sessionId 工作树会话 id（其事件将被继承）
 * @param {string} projectPath 检出后的本地项目路径（新会话 cwd）
 * @param {{ branch?: string, worktreePath?: string }} [checkoutInfo] 首条消息的一次性检出上下文
 * @returns {Promise<{ ok: boolean, error?: string, targetSessionId?: string }>} 继承会话 id（创建失败时 ok=false）
 */
export async function handbackWorktreeSession(
  ctx: HostContext,
  worktreesRoot: string,
  sessionId: string,
  projectPath: string,
  checkoutInfo: CheckoutInfo = {},
): Promise<OperationResult<{ targetSessionId: string }>> {
  const agent = ctx.agents?.get?.(sessionId)
  const sourceSession = agent?.session ?? findSession(ctx, sessionId)
  if (!sourceSession)
    return { ok: false, error: `未找到工作树会话：${sessionId}` }
  const targetSessionId = `session-${randomUUID()}`
  try {
    const presets = ctx.get?.('agentPresets')
    const parentPreset = agent
      ? (presets?.composedPreset(agent.ctx) ?? sourceSession.header?.agentPreset)
      : sourceSession.header?.agentPreset
    const seed = Array.isArray(sourceSession.events) ? sourceSession.events : []
    const options: any = {
      sessionId: targetSessionId,
      seed,
      meta: {
        cwd: projectPath,
        parentSession: sourceSession.id,
        seedLength: seed.length,
        ...(parentPreset ? { agentPreset: parentPreset } : {}),
      },
      agentOptions: agent?.options ?? {},
    }
    if (agent && presets && parentPreset) {
      // setup may return a transaction; do not leak composeFrom()'s preset id.
      options.setup = (agentCtx: any) => {
        presets.composeFrom(agentCtx, agent.ctx)
      }
    }
    await ctx.agents.create(options)
    const workspace = await ctx.workspaceRegistry.resolveByPath(projectPath)
    if (workspace)
      await workspace.attachSession(targetSessionId)
    await setPendingCheckoutContext(worktreesRoot, targetSessionId, {
      projectPath,
      branch: checkoutInfo.branch,
      worktreePath: checkoutInfo.worktreePath,
      checkedOutAt: new Date().toISOString(),
    })
    return { ok: true, targetSessionId }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 检出本地（UI 流程）：本地分支切换后、删除工作树之前，先用本地 cwd 创建新会话，
 * 并把工作树会话的完整事件作为 seed 覆盖过去。只有新会话创建成功才删除工作树。
 * @param {any} ctx
 * @param {string} worktreesRoot
 * @param {{ worktree_hash_dirname?: string, sessionId?: string, branch_name?: string }} params
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, branch?: string, projectPath?: string, targetSessionId?: string, warning?: string }>} 检出 + 带回结果
 */
export async function checkoutToLocalAndHandback(
  ctx: HostContext,
  worktreesRoot: string,
  params: WorktreeParams,
  opts: CheckoutOptions = {},
): Promise<OperationResult<{ branch: string, projectPath: string, targetSessionId?: string }>> {
  const sessionId = String(params.sessionId ?? '')
  let targetSessionId
  const checkout = await checkoutToLocal(ctx, worktreesRoot, params, {
    ...opts,
    beforeRemove: async (prepared) => {
      const handback = await handbackWorktreeSession(ctx, worktreesRoot, sessionId, prepared.projectPath, {
        branch: prepared.branch,
        worktreePath: prepared.worktreePath,
      })
      if (handback.ok)
        targetSessionId = handback.targetSessionId
      return handback
    },
  })
  if (!checkout.ok)
    return checkout
  return { ok: true, branch: checkout.branch, projectPath: checkout.projectPath, targetSessionId }
}

/**
 * 放弃更改：删除工作树并解除绑定（会话保留）。
 * @param {any} ctx
 * @param {string} worktreesRoot
 * @param {{ worktree_hash_dirname?: string, sessionId?: string }} params
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, worktreePath?: string }>} 放弃结果
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

// ---------------------------------------------------------------------------
// 工具定义（Agent 自发调用）
// ---------------------------------------------------------------------------

/** 文本渲染助手：渲染成模型可见文本。 */
function textBlock(text: string): Array<{ type: 'text', text: string }> {
  return [{ type: 'text', text }]
}

/**
 * turn/end 后完成工作树会话交接。此时 sourceSession.events 已包含触发工具的完整 turn，
 * 可安全作为新会话 seed；在开放 turn 内复制会得到不平衡的会话日志。
 */
export async function completeWorktreeHandoff(
  ctx: HostContext,
  worktreesRoot: string,
  handoff: PendingHandoff,
): Promise<void> {
  const { sourceAgent, targetSessionId, binding } = handoff
  const sourceSession = sourceAgent.session
  try {
    const presets = ctx.get?.('agentPresets')
    const parentPreset = presets?.composedPreset(sourceAgent.ctx) ?? sourceSession.header.agentPreset
    const seed = sourceSession.events
    const handle = await ctx.agents.create({
      sessionId: targetSessionId,
      seed,
      meta: {
        cwd: binding.worktreePath,
        parentSession: sourceSession.id,
        seedLength: seed.length,
        ...(parentPreset ? { agentPreset: parentPreset } : {}),
      },
      agentOptions: sourceAgent.options ?? {},
      setup: (agentCtx: any) => {
        if (presets && parentPreset)
          presets.composeFrom(agentCtx, sourceAgent.ctx)
      },
    })
    const workspace = await ctx.workspaceRegistry.resolveByPath(binding.projectPath)
    if (workspace)
      await workspace.attachSession(targetSessionId)
    handle.agent.followup({
      id: `message-${randomUUID()}`,
      role: 'user',
      content: [{
        type: 'text',
        text: 'The task has moved to an isolated worktree session. Continue the user request from the inherited context without explaining the handoff again.',
      }],
      source: { kind: 'user' },
    })
  }
  catch (error) {
    // 未发布时可以完整回滚；已发布时保留工作树，避免正在运行的新会话丢失 cwd。
    if (!ctx.agents.get(targetSessionId)) {
      await discardWorktree(ctx, worktreesRoot, { sessionId: targetSessionId })
    }
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`create_worktree handoff failed for ${targetSessionId}: ${message}`)
  }
}

/** 组装三个工具定义（create_worktree / checkout_worktree / discard_worktree）。 */
export function createToolSet(
  ctx: HostContext,
  config: PluginConfig,
  pendingHandoffs: Map<string, PendingHandoff> = new Map(),
): any[] {
  const worktreesRoot = config.worktreesRoot || join(homedir(), '.dsh')

  return [
    {
      name: 'create_worktree',
      description:
        'Use only when the user explicitly asks to work in a worktree and the current session is local. '
        + 'It creates an isolated worktree and hands the full context to a new session after the current turn. '
        + 'Do not call it from an existing worktree session.',
      parameters: {
        type: 'object',
        properties: {
          branch_name: {
            type: 'string',
            description: 'New worktree branch, for example `dsh/feature-xyz`; the `dsh/` prefix is added when omitted.',
          },
          carry_staged: {
            type: 'boolean',
            description: 'Whether to carry the source repository\'s staged (index) changes into the new worktree, '
              + 'so the isolated session starts from the same staged state. Only staged changes are carried; '
              + 'unstaged and untracked changes stay in the source repository. Default false.',
            default: false,
          },
        },
        required: ['branch_name'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            targetSessionId: { type: 'string' },
            worktreePath: { type: 'string' },
            branch: { type: 'string' },
            warning: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args: unknown, value: any) => value.ok
          ? textBlock(`✅ Created worktree ${value.branch}; the UI will switch to the inherited worktree session after this turn.`)
          : textBlock(`❌ Failed to create worktree: ${value.error}`),
      },
      async execute(args: any, exec: any) {
        const sourceAgent = exec?.agent
        const sourceSession = sourceAgent?.session
        if (!sourceAgent || !sourceSession)
          return { ok: false, error: 'create_worktree requires a current agent session' }
        if (loadLedgerSync(worktreesRoot)[sourceSession.id])
          return { ok: false, error: 'The current session is already in a worktree' }

        const targetSessionId = `session-${randomUUID()}`
        const projectPath = await resolveProjectPath(ctx, sourceSession)
        if (!projectPath)
          return { ok: false, error: '无法解析当前会话的工作目录：会话尚未就绪，请稍后重试' }
        const created = await ensureWorktree(ctx, worktreesRoot, projectPath, targetSessionId, {
          sourceSessionId: sourceSession.id,
          branchName: String(args.branch_name ?? ''),
          carryStaged: args.carry_staged === true,
          signal: exec?.signal,
        })
        if (!created.ok)
          return { ok: false, error: created.error }

        pendingHandoffs.set(sourceSession.id, {
          sourceAgent,
          targetSessionId,
          binding: created.binding,
        })

        return {
          ok: true,
          targetSessionId,
          worktreePath: created.binding.worktreePath,
          branch: created.binding.branchName,
        }
      },
    },
    {
      name: 'checkout_worktree',
      description:
        'User-authorized operation only. Call this tool only after a direct human user explicitly requests or approves checkout. '
        + 'Task completion, a merged PR, or inferred convenience is not permission to call it. When checkout would be a natural next step, '
        + 'such as after a PR is merged, you may ask the user whether they want to check out the worktree; wait for their approval before calling. '
        + 'Bring the current isolated worktree back to the local repository, preserve its changes on the worktree branch, '
        + 'create or switch to the requested local branch, and remove the isolated worktree. The main branch is unchanged.',
      parameters: {
        type: 'object',
        properties: {
          worktree_hash_dirname: {
            type: 'string',
            description: 'Worktree key in `[hash]/[dirname]` form, as shown in the session context.',
          },
          branch_name: {
            type: 'string',
            description: 'Local branch name, such as `dsh/feature-xyz` or `feature-xyz`; used exactly as provided.',
          },
          carry_staged: {
            type: 'boolean',
            description: 'Whether to carry the worktree\'s staged (index) changes into the checked-out local branch '
              + 'before the worktree is removed. Committed work is always carried; staged-only work would otherwise '
              + 'be lost with the removed worktree. Default false.',
            default: false,
          },
        },
        required: ['worktree_hash_dirname', 'branch_name'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            branch: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },

        render: (_args: unknown, value: any) => {
          if (!value.ok)
            return textBlock(`❌ Checkout failed: ${value.error}`)
          return textBlock(`✅ Checked out local branch ${value.branch}; the worktree was removed.`)
        },
      },
      async execute(args: any, exec: any) {
        const r = await checkoutToLocal(ctx, worktreesRoot, {
          worktree_hash_dirname: String(args.worktree_hash_dirname ?? ''),
          sessionId: exec?.agent?.session?.id,
          branch_name: String(args.branch_name ?? ''),
        }, {
          signal: exec?.signal,
          carryStaged: args.carry_staged === true,
        })
        if (!r.ok)
          return { ok: false, error: r.error }
        return { ok: true, branch: r.branch, projectPath: r.projectPath }
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// HTTP 路由（客户端 /api/dsh-worktree/*）
// ---------------------------------------------------------------------------

/** 构建路由列表。 */
export function buildRoutes(ctx: HostContext, config: PluginConfig): any[] {
  const worktreesRoot = config.worktreesRoot || join(homedir(), '.dsh')

  const routes = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: routeHandler(async (body, req) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = String(url.searchParams.get('sessionId') ?? body.sessionId ?? '')
        const ledger = await loadLedger(worktreesRoot)
        const binding = ledger[sessionId] ?? null
        const activeBinding = binding && existsSync(binding.worktreePath) ? binding : null
        const session = findSession(ctx, sessionId)
        const projectPath = binding?.projectPath ?? (await resolveProjectPath(ctx, session))
        // 会话工作目录不在 git 仓库内时禁止工作树：isGit 供客户端隐藏模式选择器并强制本地模式。
        // 会话未知（新建/启动竞态，尚无 cwd）时不猜测：isGit 置 null，客户端保持默认并稍后
        // 重试，避免把 git 目录误判成非 git 而隐藏工作树模式选择器。
        const isGit = projectPath ? Boolean(await gitToplevel(projectPath)) : null
        return [200, activeBinding
          ? {
              mode: 'worktree',
              hash: activeBinding.hash,
              dirname: activeBinding.dirname,
              worktreeKey: worktreeKey(activeBinding.hash, activeBinding.dirname),
              worktreePath: activeBinding.worktreePath,
              projectPath,
              sourceSessionId: activeBinding.sourceSessionId,
              log: Array.isArray(activeBinding.log) ? activeBinding.log : [],
              isGit,
            }
          : { mode: 'local', projectPath: projectPath ?? '', isGit }]
      }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/create`,
      handler: routeHandler(async (body) => {
        const sessionId = String(body.sessionId ?? '')
        const sourceSessionId = String(body.sourceSessionId ?? sessionId)
        if (!sessionId)
          return [400, { error: '缺少 sessionId' }]
        const sourceSession = findSession(ctx, sourceSessionId)
        const projectPath = await resolveProjectPath(ctx, sourceSession)
        if (!projectPath)
          return [400, { error: '无法解析会话工作目录：会话尚未就绪，请稍后重试' }]
        const r = await ensureWorktree(ctx, worktreesRoot, projectPath, sessionId, {
          sourceSessionId,
          carryStaged: body.carryStaged === true,
        })
        if (!r.ok)
          return [400, { error: r.error }]
        return [200, {
          ok: true,
          hash: r.binding.hash,
          dirname: r.binding.dirname,
          worktreeKey: worktreeKey(r.binding.hash, r.binding.dirname),
          worktreePath: r.binding.worktreePath,
          projectPath: r.binding.projectPath,
          sourceSessionId: r.binding.sourceSessionId,
          log: r.log,
          existed: r.existed,
        }]
      }, { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/attach`,
      handler: routeHandler(async (body) => {
        const sessionId = String(body.sessionId ?? '')
        if (!sessionId)
          return [400, { error: '缺少 sessionId' }]
        const ledger = await loadLedger(worktreesRoot)
        const binding = ledger[sessionId]
        if (!binding)
          return [404, { error: '未找到绑定的工作树' }]
        const workspace = await ctx.workspaceRegistry.resolveByPath(binding.projectPath)
        if (!workspace)
          return [404, { error: `未找到源工作区：${binding.projectPath}` }]
        await workspace.attachSession(sessionId)
        return [200, { ok: true, workspaceId: workspace.id }]
      }, { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/checkout`,
      handler: routeHandler(async (body) => {
        // UI 检出：git 检出 + 把工作树会话完整历史带回本地新会话（targetSessionId）。
        // body.carryStaged 可选：把工作树已暂存内容携带回本地检出。
        const r = await checkoutToLocalAndHandback(ctx, worktreesRoot, {
          sessionId: String(body.sessionId ?? ''),
          worktree_hash_dirname: String(body.worktreeHashDirname ?? ''),
          branch_name: String(body.branchName ?? ''),
        }, { carryStaged: body.carryStaged === true })
        if (!r.ok)
          return [400, { error: r.error }]
        return [200, {
          ok: true,
          branch: r.branch,
          projectPath: r.projectPath,
          targetSessionId: r.targetSessionId,
        }]
      }, { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/discard`,
      handler: routeHandler(async (body) => {
        const r = await discardWorktree(ctx, worktreesRoot, {
          sessionId: String(body.sessionId ?? ''),
          worktree_hash_dirname: String(body.worktreeHashDirname ?? ''),
        })
        if (!r.ok)
          return [400, { error: r.error }]
        return [200, { ok: true }]
      }, { mutate: true }),
    },
  ]
  return routes.map(route => ({
    ...route,
    handler: withConnectionAuth(ctx.connection, route.handler, 'dsh-tauri-worktree'),
  }))
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * 插件体：注册工具、HTTP 路由与系统提示注入。
 * @param {any} ctx - 客户端根上下文（注入 tools/systemPrompt/webServer/sessions/workspaceRegistry）。
 * @param {Record<string, unknown>} [config] - 插件行配置（worktreesRoot 等）。
 */
export function apply(ctx: HostContext, config: PluginConfig = {}): void {
  const cfg = config ?? {}
  const worktreesRoot = typeof cfg.worktreesRoot === 'string' && cfg.worktreesRoot
    ? cfg.worktreesRoot
    : join(homedir(), '.dsh')

  // 1) 工具注册。create_worktree 的交接延迟到源 turn/end，确保 seed 是完整日志。
  const pendingHandoffs = new Map<string, PendingHandoff>()
  // 只有 provider 确实参与过模型组装的会话，才允许在 turn/end 消费一次性上下文。
  // 新继承会话发布、列表同步或其他空转事件不能提前清除它。
  const injectedCheckoutContexts = new Set<string>()
  for (const tool of createToolSet(ctx, cfg, pendingHandoffs)) {
    ctx.tools.register(tool)
  }
  ctx.on('session/event', (session: any, event: any) => {
    if (event.type !== 'turn/end')
      return
    const handoff = pendingHandoffs.get(session.id)
    if (handoff) {
      pendingHandoffs.delete(session.id)
      void completeWorktreeHandoff(ctx, worktreesRoot, handoff)
    }
    // 仅当 systemPrompt.context provider 已实际返回过检出信息，才在该轮结束后消费。
    // 否则新会话发布时出现的既有/空转 turn/end 会在用户首条消息前误删上下文。
    if (injectedCheckoutContexts.delete(session.id))
      void clearPendingCheckoutContext(worktreesRoot, session.id)
  })

  // 2) 自愈旧版本遗留：只注销普通 Workspace 记录，不删除工作树或会话。
  ctx.effect(() => {
    const ledger = loadLedgerSync(worktreesRoot)
    void Promise.all(Object.values(ledger).map(binding => unregisterWorktreeWorkspace(ctx, binding.worktreePath)))
  }, 'dsh-tauri-worktree: unregister legacy worktree workspaces')

  // 3) 检出后的第一条用户消息：作为 DSH dynamic runtime context 注入，而不是
  // 主动 followup 启动额外 turn。目标会话的 header.cwd 已绑定 projectPath。
  ctx.systemPrompt.context({
    name: 'plugin:dsh-tauri-worktree:checkout',
    order: WORKTREE_SECTION_ORDER,
    text: (context: any) => {
      const sessionId = context?.scope?.session?.id
      if (!sessionId)
        return ''
      const checkout = loadCheckoutContextsSync(worktreesRoot)[sessionId]
      if (!checkout)
        return ''
      injectedCheckoutContexts.add(sessionId)
      return (
        `Worktree checkout completed.\n`
        + `is_worktree: false\n`
        + `Removed worktree: ${checkout.worktreePath ?? 'unknown'}\n`
        + `Current local project directory: ${checkout.projectPath}\n`
        + `Current local branch: ${checkout.branch ?? 'unknown'}\n\n`
        + `Continue this request in the local project directory. Do not use the removed worktree path.`
      )
    },
  })

  // 4) 系统提示注入：处于工作树时会话的上下文标记 is_worktree: true。
  ctx.systemPrompt.section({
    name: 'plugin:dsh-tauri-worktree',
    order: WORKTREE_SECTION_ORDER,
    // 每次组装按调用作用域重算：scope 是该 Agent 时读其会话的绑定状态。
    text: (context: any) => {
      const session = context?.scope?.session
      const sessionId = session?.id
      if (!sessionId)
        return ''
      const ledger = loadLedgerSync(worktreesRoot)
      const binding = ledger[sessionId]
      if (!binding)
        return ''
      return (
        `This session is running in an isolated worktree.\n`
        + `is_worktree: true\n`
        + `Worktree key: ${worktreeKey(binding.hash, binding.dirname)}\n`
        + `Worktree path: ${binding.worktreePath}\n`
        + `Project path: ${binding.projectPath}\n\n`
        + `Make code changes inside the bound worktree and use its path as the shell workdir. `
        + `The worktree contains only tracked files: node_modules and generated build dirs are not carried over, `
        + `so if the project needs its dependencies, run the package manager install (e.g. \`pnpm install\`) inside the worktree first. `
        + `checkout_worktree is user-authorized only: call it only after a direct human user explicitly requests or approves checkout. `
        + `Task completion, a merged PR, or inferred convenience is not permission to call it. When checkout would be a natural next step, `
        + `such as after a PR is merged, you may ask the user whether they want to check out the worktree; wait for their approval before calling.`
      )
    },
  })

  // 5) HTTP 路由注册（客户端 UI 经此调用 create/status/checkout/discard）。
  ctx.effect(() => {
    const disposers = buildRoutes(ctx, cfg).map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
