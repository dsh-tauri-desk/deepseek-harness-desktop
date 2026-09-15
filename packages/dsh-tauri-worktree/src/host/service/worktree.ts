import type {
  Binding,
  CheckoutOptions,
  EnsureOptions,
  OperationResult,
  WorktreeParams,
  WorktreeProcessController,
} from '../types'
import { existsSync } from 'node:fs'
import { rmdir } from 'node:fs/promises'
import process from 'node:process'
import { defineService, DSH_HOME } from 'dsh-tauri'
import { compact, filter, find, get, isEmpty, map, reject, some } from 'lodash-es'
import { join, resolve } from 'pathe'
import { LINK_DEPENDENCIES, TRASH_DIR, WORKTREE_BRANCH_NAME_PATTERN, WORKTREES_DIR } from '../config/constants'
import { getCurrentHostInstance } from '../config/runtime'
import {
  isDependencyInstallCommand,
  linkWorktreeDependencies,
  normalizeLinkDirectories,
  shellCommandFrom,
  shellSessionIdFrom,
  unlinkWorktreeDependencies,
} from '../utils/dependencies'
import { removeDirectoryReliably } from '../utils/filesystem'
import {
  applyStagedPatch,
  carryStagedChanges,
  git,
  gitToplevel,
  headSubject,
  projectDirname,
  shortHead,
  stagedPatch,
} from '../utils/git'
import { computeHash, parseWorktreeKey, worktreeKey, worktreePath, worktreeTrashPath } from '../utils/paths'
import { cleaner } from './cleaner'
import { ledger } from './ledger'
import { workspace } from './workspace'

export const worktree = defineService({
  async create(
    projectPath: string,
    sessionId: string,
    options: EnsureOptions = {},
  ): Promise<OperationResult<{ binding: Binding, log: string[], existed: boolean }>> {
    const root = await gitToplevel(projectPath)
    if (!root)
      return { ok: false, error: `项目路径不是 git 仓库顶层：${projectPath}` }

    const hash = computeHash(projectPath, sessionId)
    const dirname = projectDirname(projectPath)
    const path = worktreePath(hash, dirname)
    const linkDirectories = normalizeLinkDirectories(options.linkDependencyDirectories)
    const linkDependencies = options.linkDependencies ?? LINK_DEPENDENCIES

    const existing = ledger.load(sessionId)
    if (existing && !samePath(existing.worktreePath, path)) {
      return { ok: false, error: `会话已绑定的其他工作树与本次计算路径不一致：${existing.worktreePath}（期望 ${path}）；请先放弃或检出该会话的原工作树` }
    }
    if (existing && existsSync(existing.worktreePath)) {
      const registration = await isRegisteredWorktree(root, path, options.signal)
      if (!registration.ok)
        return { ok: false, error: `检查工作树残留状态失败：${registration.error}` }
      if (registration.registered)
        return { ok: true, binding: existing, existed: true, log: [] }
    }

    const mainSource = 'refs/heads/main'
    const mainRef = await git(['rev-parse', '--verify', '--quiet', mainSource], root, { signal: options.signal })
    if (!mainRef.ok)
      return { ok: false, error: `创建工作树失败：本地分支 main 不存在或无法解析（refs/heads/main）：${mainRef.error}` }
    if (!mainRef.out.trim())
      return { ok: false, error: '创建工作树失败：本地分支 main 不存在或无法解析（refs/heads/main）：empty git response' }

    const registration = await isRegisteredWorktree(root, path, options.signal)
    if (!registration.ok)
      return { ok: false, error: `检查工作树残留状态失败：${registration.error}` }

    if (existsSync(path)) {
      if (registration.registered) {
        return { ok: false, error: `目标路径已是 Git 工作树但缺少当前会话绑定，拒绝覆盖：${path}` }
      }
      const removed = await removeWorktreeOnDisk(sessionId, root, path, hash, dirname, linkDirectories, options.signal)
      if (!removed.ok)
        return { ok: false, error: `清理孤儿工作树目录失败：${removed.error}` }
    }
    else {
      const pruned = await pruneWorktreeAdmin(root, options.signal)
      if (!pruned.ok)
        return { ok: false, error: `清理工作树管理记录失败：${pruned.error}` }
    }

    const requestedBranch = String(options.branchName ?? '').trim()
    if (requestedBranch && !WORKTREE_BRANCH_NAME_PATTERN.test(requestedBranch))
      return { ok: false, error: `非法分支名：${requestedBranch}` }
    const branchName = requestedBranch
      ? (requestedBranch.startsWith('dsh/') ? requestedBranch : `dsh/${requestedBranch.replace(/^\/+/, '')}`)
      : ''
    if (branchName === 'dsh/')
      return { ok: false, error: '分支名不能为空' }
    if (branchName) {
      const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], root, { signal: options.signal })
      if (exists.ok && exists.out.trim())
        return { ok: false, error: `分支已存在：${branchName}` }
    }

    const log = ['Starting worktree creation']
    const addArgs = branchName
      ? ['worktree', 'add', '-b', branchName, path, mainSource]
      : ['worktree', 'add', '--detach', path, mainSource]
    const add = await git(addArgs, root, { signal: options.signal })
    if (!add.ok)
      return { ok: false, error: `创建工作树失败：${add.error}` }

    if (options.carryStaged === true) {
      const carried = await carryStagedChanges(root, path, { signal: options.signal })
      if (!carried.ok) {
        const rollbackFailures = await rollbackWorktree(sessionId, root, path, hash, dirname, linkDirectories, branchName, options.signal)
        const suffix = rollbackFailures.length > 0 ? `；回滚不完整：${rollbackFailures.join('；')}` : '，工作树已回滚'
        return { ok: false, error: `携带暂存内容失败：${carried.error}${suffix}` }
      }
      if (carried.carried.length > 0)
        log.push(`Carried staged changes (${carried.carried.length} file(s)) from the source repository`)
    }

    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], path)
    const activeBranch = head.ok && head.out !== 'HEAD' ? head.out : (branchName || '(detached)')
    log.push(branchName
      ? `Preparing worktree (branch ${branchName})`
      : `Preparing worktree (detached HEAD ${await shortHead(path)})`)
    log.push(`HEAD is now at ${await shortHead(path)} ${await headSubject(path)}`)
    log.push(`Worktree created at ${path}`)

    const linkedDependencies: string[] = []
    if (linkDependencies) {
      try {
        const linked = await linkWorktreeDependencies(root, path, linkDirectories)
        linkedDependencies.push(...linked.linked)
        if (linked.linked.length > 0)
          log.push(`Linked dependencies from the source repository (${linked.linked.join(', ')}); install will materialize an independent copy`)
        log.push(...map(
          filter(linked.skipped, name => existsSync(join(root, name))),
          name => `Dependency directory already present, kept as-is (${name})`,
        ))
      }
      catch (error) {
        log.push(`Dependency link skipped: ${get(error, 'message', String(error))}`)
      }
    }

    const binding: Binding = {
      sessionId,
      sourceSessionId: options.sourceSessionId || sessionId,
      hash,
      dirname,
      worktreePath: path,
      projectPath: root,
      branchName: activeBranch,
      ownsBranch: Boolean(branchName),
      createdAt: new Date().toISOString(),
      log,
      ...(linkedDependencies.length > 0 ? { linkedDependencies } : {}),
    }
    try {
      await ledger.save(sessionId, binding)
    }
    catch {
      const rollbackFailures = await rollbackWorktree(sessionId, root, path, hash, dirname, linkDirectories, branchName, options.signal)
      const suffix = rollbackFailures.length > 0 ? `；回滚不完整：${rollbackFailures.join('；')}` : '，已回滚'
      return { ok: false, error: `保存工作树记录失败${suffix}` }
    }

    return { ok: true, binding, log, existed: false }
  },

  async checkout(
    params: WorktreeParams,
    options: CheckoutOptions = {},
  ): Promise<OperationResult<{ branch: string, projectPath: string, worktreePath: string }>> {
    const binding = resolveBinding(params.sessionId, params.worktreeHashDirname ?? params.worktree_hash_dirname)
    if (!binding)
      return { ok: false, error: '未找到绑定的工作树' }
    if (!existsSync(binding.worktreePath))
      return { ok: false, error: `工作树目录不存在：${binding.worktreePath}` }

    const root = binding.projectPath
    const linkDirectories = removalLinkDirectories(binding, options.linkDependencyDirectories)
    const branch = String(params.branch_name ?? binding.branchName ?? '').trim()
    if (!branch || branch.endsWith('/'))
      return { ok: false, error: `分支名不能为空或以 / 结尾：${branch}` }
    const validBranch = await git(['check-ref-format', '--branch', branch], root, { signal: options.signal })
    if (!validBranch.ok)
      return { ok: false, error: `非法分支名：${branch}` }

    const mainStatus = await git(['status', '--porcelain=v1'], root, { signal: options.signal })
    if (!mainStatus.ok)
      return { ok: false, error: `读取本地主工作区状态失败：${mainStatus.error}` }
    if (mainStatus.out)
      return { ok: false, error: '本地主工作区存在未提交改动；请先提交或清理后再检出工作树' }
    const worktreeStatus = await git(['status', '--porcelain=v1'], binding.worktreePath, { signal: options.signal })
    if (!worktreeStatus.ok)
      return { ok: false, error: `读取隔离工作树状态失败：${worktreeStatus.error}` }
    const dirtyRows = compact(worktreeStatus.out.split('\n'))
    const unsupportedRows = reject(dirtyRows, row => /^[ACDMRT] /.test(row))
    if (unsupportedRows.length > 0)
      return { ok: false, error: '隔离工作树存在未暂存或未跟踪改动；请先提交这些改动再检出，避免删除工作树时丢失内容' }
    if (dirtyRows.length > 0 && options.carryStaged !== true)
      return { ok: false, error: '隔离工作树存在已暂存改动；请启用 carry_staged 或先提交这些改动再检出' }

    const worktreeHead = await git(['rev-parse', 'HEAD'], binding.worktreePath, { signal: options.signal })
    if (!worktreeHead.ok)
      return { ok: false, error: `读取工作树 HEAD 失败：${worktreeHead.error}` }
    const prev = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root, { signal: options.signal })
    if (!prev.ok)
      return { ok: false, error: '本地主工作区当前处于 detached HEAD；请先切换到本地分支再检出工作树' }
    const prevBranch = prev.out
    const carriedPatch: OperationResult<{ patch: string }> = options.carryStaged === true
      ? await stagedPatch(binding.worktreePath, { signal: options.signal })
      : { ok: true, patch: '' }
    if (!carriedPatch.ok)
      return { ok: false, error: `读取工作树暂存内容失败：${carriedPatch.error}` }

    const branchRef = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root, { signal: options.signal })
    const handsOffOwnedBranch = binding.ownsBranch && binding.branchName === branch
    let detachedOwnedBranch = false
    let createdBranch = false
    if (handsOffOwnedBranch) {
      if (!branchRef.ok)
        return { ok: false, error: `工作树拥有的本地分支不存在，拒绝重建以避免覆盖状态：${branch}` }
      if (branchRef.out !== worktreeHead.out)
        return { ok: false, error: `工作树 HEAD 与其本地分支指针不一致，拒绝检出：${branch}` }
      const activeBranch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], binding.worktreePath, { signal: options.signal })
      if (!activeBranch.ok || activeBranch.out !== branch)
        return { ok: false, error: `工作树未签出其记录的本地分支，拒绝检出：${branch}` }
      const detached = await git(['checkout', '--detach'], binding.worktreePath, { signal: options.signal })
      if (!detached.ok)
        return { ok: false, error: `释放工作树分支失败：${detached.error}` }
      detachedOwnedBranch = true
    }
    else {
      if (branchRef.ok)
        return { ok: false, error: `本地分支已存在且不属于当前工作树，为避免覆盖其提交而拒绝检出：${branch}` }
      const created = await git(['branch', branch, worktreeHead.out], root, { signal: options.signal })
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
      const switchedBack = await git(['checkout', prevBranch], root, { signal: options.signal })
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

    const check = await git(['checkout', branch], root, { signal: options.signal })
    if (!check.ok) {
      const recovery = detachedOwnedBranch ? await restoreSourceBranch() : await removeCreatedBranch()
      return { ok: false, error: `切换到本地分支失败：${check.error}${recovery}` }
    }

    if (carriedPatch.patch.trim()) {
      const applied = await applyStagedPatch(root, carriedPatch.patch, { signal: options.signal })
      if (!applied.ok) {
        const recovery = await rollbackHandoff(true)
        return { ok: false, error: `携带暂存内容失败，工作树已保留：${applied.error}${recovery}` }
      }
    }

    if (options.beforeRemove) {
      const prepared = await options.beforeRemove({ branch, projectPath: root, worktreePath: binding.worktreePath })
      if (!prepared.ok) {
        const recovery = await rollbackHandoff(Boolean(carriedPatch.patch.trim()))
        return { ok: false, error: `Failed to create the local handback session; the worktree was preserved: ${prepared.error}${recovery}` }
      }
    }

    await workspace.unregister(binding.worktreePath)
    const removed = await removeWorktreeOnDisk(
      binding.sessionId,
      root,
      binding.worktreePath,
      binding.hash,
      binding.dirname,
      linkDirectories,
      options.signal,
    )
    if (!removed.ok) {
      const recovery = existsSync(binding.worktreePath)
        ? await rollbackHandoff(Boolean(carriedPatch.patch.trim()))
        : ''
      return { ok: false, error: `删除工作树失败，绑定已保留以便重试：${removed.error}${recovery}` }
    }

    await ledger.remove(binding.sessionId)

    return { ok: true, branch, projectPath: root, worktreePath: binding.worktreePath }
  },

  async discard(sessionId: string, key: string): Promise<OperationResult<{ jobId?: string }>> {
    const binding = ledger.load(sessionId)
    const parsed = parseWorktreeKey(key)
    if (!binding && parsed && !existsSync(worktreePath(parsed.hash, parsed.dirname)))
      return { ok: true }
    const job = cleaner.start(sessionId, key, binding?.worktreePath, () => worktree.remove(sessionId, key))
    return { ok: true, jobId: job.jobId }
  },

  async remove(sessionId: string, key = ''): Promise<OperationResult<{ worktreePath: string }>> {
    const binding = resolveBinding(sessionId, key)
    if (!binding)
      return { ok: false, error: '未找到绑定的工作树' }

    await workspace.unregister(binding.worktreePath)
    const removed = await removeWorktreeOnDisk(
      binding.sessionId,
      binding.projectPath,
      binding.worktreePath,
      binding.hash,
      binding.dirname,
      removalLinkDirectories(binding),
    )
    if (!removed.ok)
      return { ok: false, error: `删除工作树失败，绑定已保留以便重试：${removed.error}` }

    if (binding.ownsBranch && binding.branchName) {
      const dropped = await deleteOwnedBranch(binding.projectPath, binding.branchName)
      if (!dropped.ok)
        return { ok: false, error: `删除工作树分支失败，绑定已保留以便重试：${dropped.error}` }
    }

    await ledger.remove(binding.sessionId)

    return { ok: true, worktreePath: binding.worktreePath }
  },

  async detach(exec: unknown): Promise<string[]> {
    const command = shellCommandFrom(exec)
    if (!command || !isDependencyInstallCommand(command))
      return []
    const sessionId = shellSessionIdFrom(exec)
    if (!sessionId)
      return []
    const binding = ledger.load(sessionId)
    if (!binding?.worktreePath)
      return []
    const directories = normalizeLinkDirectories([
      ...(binding.linkedDependencies ?? []),
      ...normalizeLinkDirectories(),
    ])
    const unlinked = await unlinkWorktreeDependencies(binding.worktreePath, directories)
    if (unlinked.length > 0) {
      getCurrentHostInstance().logger?.info?.(
        `dsh-tauri-worktree: unlinked ${unlinked.join(', ')} before install in ${binding.worktreePath}; `
        + 'the package manager will materialize an independent copy',
      )
    }
    return unlinked
  },
})

// --- internal ---

async function removeEmptyHashContainers(hash: string): Promise<void> {
  await Promise.all(map(
    [join(DSH_HOME, WORKTREES_DIR, hash), join(DSH_HOME, TRASH_DIR, hash)],
    container => rmdir(container).catch(() => {}),
  ))
}

async function pruneWorktreeAdmin(root: string, signal?: AbortSignal): Promise<OperationResult> {
  const pruned = await git(['worktree', 'prune', '--expire', 'now'], root, { signal })
  return pruned.ok ? { ok: true } : { ok: false, error: pruned.error }
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32'
    ? left.replaceAll('/', '\\').toLowerCase() === right.replaceAll('/', '\\').toLowerCase()
    : left === right
}

async function isRegisteredWorktree(root: string, path: string, signal?: AbortSignal): Promise<OperationResult<{ registered: boolean }>> {
  const listed = await git(['worktree', 'list', '--porcelain'], root, { signal })
  if (!listed.ok)
    return { ok: false, error: listed.error }
  const registered = some(compact(listed.out.split('\n')), line =>
    line.startsWith('worktree ') && samePath(line.slice('worktree '.length), path))
  return { ok: true, registered }
}

async function stopWorktreeProcesses(sessionId: string, path: string): Promise<void> {
  let ctx: unknown
  try {
    ctx = getCurrentHostInstance()
  }
  catch {
    ctx = undefined
  }
  const getController = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  const controller = typeof getController === 'function'
    ? getController.call(ctx, 'worktreeProcessController')
    : (ctx as { worktreeProcessController?: WorktreeProcessController } | undefined)?.worktreeProcessController
  const stop = (controller as WorktreeProcessController | undefined)?.stopSessionProcesses
  if (typeof stop !== 'function')
    return
  await stop(sessionId, path).catch(() => {})
}

async function removeWorktreeOnDisk(
  sessionId: string,
  root: string,
  path: string,
  hash: string,
  dirname: string,
  linkDirectories: readonly string[] = [],
  signal?: AbortSignal,
): Promise<OperationResult> {
  await stopWorktreeProcesses(sessionId, path)

  if (linkDirectories.length > 0)
    await unlinkWorktreeDependencies(path, linkDirectories)

  try {
    await removeDirectoryReliably(path, worktreeTrashPath(hash, dirname))
  }
  catch (error) {
    return { ok: false, error: get(error, 'message', String(error)) }
  }

  await removeEmptyHashContainers(hash)

  return pruneWorktreeAdmin(root, signal)
}

function removalLinkDirectories(binding: Binding, configured?: readonly string[]): string[] {
  const configuredDirectories = normalizeLinkDirectories(configured)
  if (isEmpty(binding.linkedDependencies))
    return configuredDirectories
  return normalizeLinkDirectories([...binding.linkedDependencies ?? [], ...configuredDirectories])
}

async function deleteOwnedBranch(root: string, branch: string, signal?: AbortSignal): Promise<OperationResult> {
  const existing = await git(['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`], root, { signal })
  if (!existing.ok)
    return { ok: false, error: existing.error }
  if (!existing.out.trim())
    return { ok: true }
  const dropped = await git(['branch', '-D', branch], root, { signal })
  return dropped.ok ? { ok: true } : { ok: false, error: dropped.error }
}

async function rollbackWorktree(
  sessionId: string,
  root: string,
  path: string,
  hash: string,
  dirname: string,
  linkDirectories: readonly string[],
  branchName: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const failures: string[] = []
  const removed = await removeWorktreeOnDisk(sessionId, root, path, hash, dirname, linkDirectories, signal)
  if (!removed.ok)
    failures.push(`移除工作树失败：${removed.error}`)
  if (branchName) {
    const dropped = await deleteOwnedBranch(root, branchName, signal)
    if (!dropped.ok)
      failures.push(`删除分支失败：${dropped.error}`)
  }
  return failures
}

function resolveBinding(sessionId?: string, key?: string): Binding | null {
  const bySession = sessionId ? ledger.load(sessionId) : null
  if (bySession)
    return bySession
  if (!key)
    return null
  return find(ledger.list(), binding =>
    Boolean(binding.hash) && Boolean(binding.dirname) && worktreeKey(binding.hash, binding.dirname) === key) ?? null
}
