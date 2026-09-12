/**
 * route.ts — 工作树 HTTP 路由（/api/dsh-worktree/*）：客户端 UI 经此调用
 * bindings / create / status / attach / checkout / discard。
 *
 * 变更操作全部标注 mutate: true，并统一由 withConnectionAuth 做连接鉴权；
 * status 的 isGit 判定遵守「会话未知时不猜测」的竞态语义（isGit: null）。
 */

import type { HostContext, PluginConfig } from '../types'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { routeHandler, withConnectionAuth } from 'dsh-tauri'
import { join } from 'pathe'
import { WORKTREE_API_PREFIX } from '../../shared/constants'
import { gitToplevel } from '../service/git'
import { checkoutToLocalAndHandback, inheritSessionIntoWorktree } from '../service/handoff'
import { discardWorktree, ensureWorktree, worktreeKey, worktreePath } from '../service/operation'
import { findSession, resolveProjectPath } from '../service/session'
import { listBindings, loadBinding } from '../storage'

/** 构建路由列表。 */
interface DiscardJob {
  jobId: string
  sessionId: string
  worktreeKey: string
  worktreePath?: string
  state: 'deleting' | 'completed' | 'failed'
  error?: string
}

const DISCARD_RETRY_ATTEMPTS = 3
const DISCARD_RETRY_DELAY_MS = 2_000
const DISCARD_JOB_RETENTION = 64

export function buildRoutes(ctx: HostContext, config: PluginConfig): any[] {
  const worktreesRoot = config.worktreesRoot || join(homedir(), '.dsh')
  const discardJobs = new Map<string, DiscardJob>()
  const discardInFlight = new Map<string, Promise<DiscardJob>>()

  const discardKey = (sessionId: string, worktreeHashDirname: string): string => `${sessionId}:${worktreeHashDirname}`
  // Keep the job map bounded: oldest settled jobs disappear first so status
  // polling of active/failed jobs keeps working during long sessions.
  const pruneDiscardJobs = (): void => {
    if (discardJobs.size < DISCARD_JOB_RETENTION)
      return
    for (const [id, item] of discardJobs) {
      if (discardJobs.size < DISCARD_JOB_RETENTION)
        break
      if (item.state === 'completed')
        discardJobs.delete(id)
    }
  }
  const runDiscard = (job: DiscardJob, key: string, worktreeHashDirname: string): Promise<DiscardJob> => {
    const existing = discardInFlight.get(key)
    if (existing)
      return existing
    const promise = (async (): Promise<DiscardJob> => {
      let lastError = ''
      for (let attempt = 0; attempt < DISCARD_RETRY_ATTEMPTS; attempt += 1) {
        const result = await discardWorktree(ctx, worktreesRoot, {
          sessionId: job.sessionId,
          worktree_hash_dirname: worktreeHashDirname,
        }, { linkDependencyDirectories: config.linkDependencyDirectories })
        if (result.ok) {
          const updated: DiscardJob = { ...job, state: 'completed' }
          discardJobs.set(job.jobId, updated)
          return updated
        }
        lastError = result.error
        if (attempt + 1 < DISCARD_RETRY_ATTEMPTS)
          await new Promise(resolve => setTimeout(resolve, DISCARD_RETRY_DELAY_MS))
      }
      const updated: DiscardJob = { ...job, state: 'failed', error: lastError }
      discardJobs.set(job.jobId, updated)
      return updated
    })().catch((error: unknown) => {
      const updated: DiscardJob = { ...job, state: 'failed', error: error instanceof Error ? error.message : String(error) }
      discardJobs.set(job.jobId, updated)
      return updated
    }).finally(() => {
      discardInFlight.delete(key)
    })
    discardInFlight.set(key, promise)
    return promise
  }

  const routes = [
    {
      kind: 'exact',
      path: `${WORKTREE_API_PREFIX}/bindings`,
      handler: routeHandler(async () => {
        // 批量绑定视图：客户端 hydration 用一次请求就知道「列表里哪些会话在工作树里」，
        // 不必为列表里每个会话各打一次 /status（实测某 profile 有 400 个会话 → 400 次请求）。
        // 只返回仍存在于磁盘的绑定（worktree 已被检出的会话按本地处理），以及未收敛的删除任务。
        const bindings = await listBindings(worktreesRoot)
        return [200, {
          bindings: bindings
            .filter(binding => binding.worktreePath && existsSync(binding.worktreePath))
            .map(binding => ({
              sessionId: binding.sessionId,
              sourceSessionId: binding.sourceSessionId ?? '',
              hash: binding.hash,
              dirname: binding.dirname,
              worktreeKey: worktreeKey(binding.hash, binding.dirname),
              worktreePath: binding.worktreePath,
              projectPath: binding.projectPath,
              log: Array.isArray(binding.log) ? binding.log : [],
            })),
          jobs: [...discardJobs.values()]
            .filter(job => job.state !== 'completed')
            .map(job => ({
              sessionId: job.sessionId,
              jobId: job.jobId,
              state: job.state,
              error: job.error,
              worktreeKey: job.worktreeKey,
              worktreePath: job.worktreePath,
            })),
        }]
      }),
    },
    {
      kind: 'exact',
      path: `${WORKTREE_API_PREFIX}/status`,
      handler: routeHandler(async (body, req) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = String(url.searchParams.get('sessionId') ?? body.sessionId ?? '')
        const jobId = String(url.searchParams.get('jobId') ?? body.jobId ?? '')
        const job = jobId
          ? discardJobs.get(jobId)
          : [...discardJobs.values()].reverse().find(item => item.sessionId === sessionId)
        if (jobId && job && job.sessionId !== sessionId)
          return [404, { error: '未找到工作树删除任务' }]
        if (job?.state === 'deleting' || job?.state === 'failed') {
          return [200, {
            mode: job.state,
            jobId: job.jobId,
            worktreeKey: job.worktreeKey,
            worktreePath: job.worktreePath,
            error: job.error,
          }]
        }
        if (job?.state === 'completed')
          return [200, { mode: 'local', jobId: job.jobId }]
        const binding = await loadBinding(worktreesRoot, sessionId)
        const activeBinding = binding && existsSync(binding.worktreePath) ? binding : null
        const session = findSession(ctx, sessionId)
        const projectPath = binding?.projectPath ?? (await resolveProjectPath(ctx, session))
        // 会话工作目录不在 git 仓库内时禁止工作树：isGit 供客户端隐藏模式选择器并强制本地模式。
        // 会话未知（新建/启动竞态，尚无 cwd）时不猜测：isGit 置 null，客户端保持默认并稍后
        // 重试，避免把 git 目录误判成非 git 而隐藏工作树模式选择器。
        // 已绑定工作树的会话必然位于 Git 仓库内（工作树由 git worktree add 创建）：直接置 true，
        // 省掉每次 status 都 fork 一个 git 子进程——status 会被客户端 hydration 反复复核。
        const isGit = activeBinding ? true : projectPath ? Boolean(await gitToplevel(projectPath)) : null
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
      path: `${WORKTREE_API_PREFIX}/create`,
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
          linkDependencies: config.linkDependencies,
          linkDependencyDirectories: config.linkDependencyDirectories,
        })
        if (!r.ok)
          return [400, { error: r.error }]
        // 继承源会话完整对话历史：仅当客户端请求 inherit 且源会话确有事件时，宿主才用
        // sourceSession.events 作为 seed 建好「已是完整会话」的工作树会话（问题 2 的修复）。
        // 否则回退官方空白会话路径（客户端用 sessionsRuntime.create({ cwd }) 兜底）。
        let inherited = false
        if (body.inherit === true) {
          const inheritedSession = await inheritSessionIntoWorktree(
            ctx,
            worktreesRoot,
            sourceSessionId,
            sessionId,
            r.binding.worktreePath,
          )
          inherited = inheritedSession.ok
        }
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
          inherited,
        }]
      }, { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${WORKTREE_API_PREFIX}/attach`,
      handler: routeHandler(async (body) => {
        const sessionId = String(body.sessionId ?? '')
        if (!sessionId)
          return [400, { error: '缺少 sessionId' }]
        const binding = await loadBinding(worktreesRoot, sessionId)
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
      path: `${WORKTREE_API_PREFIX}/checkout`,
      handler: routeHandler(async (body) => {
        // UI 检出：git 检出 + 把工作树会话完整历史带回本地新会话（targetSessionId）。
        // body.carryStaged 可选：把工作树已暂存内容携带回本地检出。
        const r = await checkoutToLocalAndHandback(ctx, worktreesRoot, {
          sessionId: String(body.sessionId ?? ''),
          worktree_hash_dirname: String(body.worktreeHashDirname ?? ''),
          branch_name: String(body.branchName ?? ''),
        }, {
          carryStaged: body.carryStaged === true,
          linkDependencyDirectories: config.linkDependencyDirectories,
        })
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
      path: `${WORKTREE_API_PREFIX}/discard`,
      handler: routeHandler(async (body) => {
        const sessionId = String(body.sessionId ?? '')
        const worktreeHashDirname = String(body.worktreeHashDirname ?? '')
        const key = discardKey(sessionId, worktreeHashDirname)
        const existing = discardInFlight.get(key)
        if (existing) {
          const job = [...discardJobs.values()].find(item => item.sessionId === sessionId && item.worktreeKey === worktreeHashDirname && item.state === 'deleting')
          if (job)
            return [200, { ok: true, jobId: job.jobId }]
        }
        const completed = [...discardJobs.values()].find(item => item.sessionId === sessionId && item.worktreeKey === worktreeHashDirname && item.state === 'completed')
        if (completed)
          return [200, { ok: true, jobId: completed.jobId }]
        const binding = await loadBinding(worktreesRoot, sessionId)
        // Idempotent re-discard: a binding-less session whose deterministic
        // worktree path is already gone was fully cleaned earlier (possibly in
        // a previous plugin lifetime). Report success instead of a phantom job.
        const [hash, dirname] = worktreeHashDirname.split('/')
        if (!binding && hash && dirname && !existsSync(worktreePath(worktreesRoot, hash, dirname)))
          return [200, { ok: true }]
        const job: DiscardJob = {
          jobId: randomUUID(),
          sessionId,
          worktreeKey: worktreeHashDirname,
          worktreePath: binding?.worktreePath,
          state: 'deleting',
        }
        pruneDiscardJobs()
        discardJobs.set(job.jobId, job)
        void runDiscard(job, key, worktreeHashDirname)
        return [200, { ok: true, jobId: job.jobId }]
      }, { mutate: true }),
    },
  ]
  return routes.map(route => ({
    ...route,
    handler: withConnectionAuth(ctx.connection, route.handler, 'dsh-tauri-worktree'),
  }))
}
