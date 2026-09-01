/**
 * route.ts — 工作树 HTTP 路由（/api/dsh-worktree/*）：客户端 UI 经此调用
 * create / status / attach / checkout / discard。
 *
 * 变更操作全部标注 mutate: true，并统一由 withConnectionAuth 做连接鉴权；
 * status 的 isGit 判定遵守「会话未知时不猜测」的竞态语义（isGit: null）。
 */

import type { HostContext, PluginConfig } from '../types/index.js'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { routeHandler, withConnectionAuth } from 'dsh-tauri'
import { join } from 'pathe'
import { WORKTREE_API_PREFIX } from '../../shared/constants.js'
import { gitToplevel } from '../service/git.js'
import { checkoutToLocalAndHandback } from '../service/handoff.js'
import { discardWorktree, ensureWorktree, worktreeKey } from '../service/operation.js'
import { findSession, resolveProjectPath } from '../service/session.js'
import { loadLedger } from '../storage/index.js'

/** 构建路由列表。 */
export function buildRoutes(ctx: HostContext, config: PluginConfig): any[] {
  const worktreesRoot = config.worktreesRoot || join(homedir(), '.dsh')

  const routes = [
    {
      kind: 'exact',
      path: `${WORKTREE_API_PREFIX}/status`,
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
      path: `${WORKTREE_API_PREFIX}/attach`,
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
      path: `${WORKTREE_API_PREFIX}/checkout`,
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
      path: `${WORKTREE_API_PREFIX}/discard`,
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
