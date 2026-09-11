/**
 * host/routes/index.ts — turnrewind HTTP 路由（客户端 UI 唯一的数据面）。
 *
 *   GET  /api/turnrewind/summary?sessionId=<id>  读本会话的 turn 变更记录
 *   GET  /api/turnrewind/live?sessionId=<id>     读运行中实时读数（客户端提示条）
 *   POST /api/turnrewind/undo                    撤销某个 turn 的文件改动
 *
 * 三条路由都经 dsh-tauri 的 routeHandler（方法严格限制、mutate 仅回环 + JSON 校验）；
 * 连接信任边界用 `ctx.get('connection')` 可选获取——服务缺席时优雅降级为
 * routeHandler 自身的回环校验，不因未注入而让插件 fiber 卡在 PENDING（见方案 2.4-B3/B5）。
 * live 是宿主定时刷新的缓存值（读内存，不起 git 子进程）。
 */

import type { WorkspaceQueue } from '../service/queue'
import type { HostContext, JsonBody, LiveSnapshot, SummaryPayload } from '../types'
import { routeHandler, withConnectionAuth } from 'dsh-tauri'
import { TURNREWIND_API_PREFIX, TURNREWIND_PLUGIN_NAME } from '../../shared/constants'
import { MAX_SUMMARY_FILES, REASON_GIT_REQUIRED } from '../constants'
import { currentDshHome, readLedger } from '../service/ledger'
import { undoTurn } from '../service/undo'
import { findSession, probeWorkspace, sessionCwdOf } from '../service/workspace'

/** 运行中实时读数的读取面（由 capture 编排器提供；未接线时返回 inactive）。 */
export type LiveStateReader = (sessionId: string) => LiveSnapshot

/**
 * 「该轮是否仍未落定」的读取面（撤销据此拒绝）。
 *
 * 不复用 {@link LiveStateReader}：读数是提示条的过程态，`turn/end` 一到就归零，
 * 而这一轮此后还要在后台结算——用读数判定会把「还在结算」误判成「可以撤销」。
 */
export type TurnPendingReader = (sessionId: string, turn: number) => boolean

/** 路由依赖（队列与捕获层共用同一实例，保证撤销与结算互斥）。 */
export interface RouteDeps {
  dshHome?: string
  live?: LiveStateReader
  /** 未落定判定；缺席时退化为「会话有活动读数」这一宽容判定（仅测试/降级路径）。 */
  isTurnPending?: TurnPendingReader
  /** 工作区级串行队列。 */
  queue: WorkspaceQueue
}

/** 每条 turn 记录最多回传多少个「不在撤销范围内」的路径（避免载荷无界）。 */
const MAX_SKIPPED_PATHS = 20

/** 构建路由列表。 */
export function buildRoutes(ctx: HostContext, options: RouteDeps): any[] {
  const dshHome = options.dshHome ?? currentDshHome()
  const live = options.live
  const queue = options.queue
  // 连接信任边界是可选能力：服务缺席时 withConnectionAuth 原样放行，
  // 由 routeHandler 自己的回环校验兜底（绝不因未注入而卡住 fiber）。
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined

  const summaryHandler = routeHandler(async (_body: JsonBody, req: any): Promise<[number, unknown]> => {
    const url = new URL(req?.url ?? '/', 'http://localhost')
    const sessionId = String(url.searchParams.get('sessionId') ?? '')
    if (sessionId.length === 0)
      return [400, { error: '缺少 sessionId' }]
    const session = findSession(ctx, sessionId)
    if (session === undefined)
      return [404, { error: '会话不存在或尚未就绪' }]
    const ledger = await readLedger(dshHome, sessionId)
    // 以**当前**资格为准（cwd 可能在会话中途切换）：账本里的旧结论只作为兜底。
    const probe = await probeWorkspace(sessionCwdOf(session))
    // 非 Git → false（客户端点撤销弹「需要 Git 仓库」）；「确实是 Git 仓库但被守卫拒绝」
    // （家目录/盘根等）保留 true，只呈现不可用原因，不误报缺少仓库。
    const refusedGitWorkspace = !probe.ok && probe.reason !== REASON_GIT_REQUIRED && ledger.isGit
    const isGit = probe.ok || refusedGitWorkspace
    const payload: SummaryPayload = {
      sessionId,
      isGit,
      workspaceRoot: probe.ok ? probe.root : ledger.workspaceRoot,
      unavailableReason: probe.ok ? null : (probe.reason ?? ledger.unavailableReason),
      turns: ledger.turns.map((turn) => {
        const truncated = turn.files.length > MAX_SUMMARY_FILES
        return {
          turn: turn.turn,
          fileCount: turn.files.length,
          insertions: turn.insertions,
          deletions: turn.deletions,
          undoneAt: turn.undoneAt ?? null,
          unavailable: turn.unavailable ?? null,
          // 失败/超限行的 refs 语义见 host/types：空 refs = 这一轮没建立过快照。
          hasBaseline: turn.beforeRef.length > 0 || turn.afterRef.length > 0,
          truncated,
          files: truncated ? turn.files.slice(0, MAX_SUMMARY_FILES) : turn.files,
          // 「不在撤销范围内」的路径：让卡片能如实标注，而不是静默漏掉。
          skippedOversized: (turn.skippedOversized ?? []).slice(0, MAX_SKIPPED_PATHS),
          skippedNestedRepos: (turn.skippedNestedRepos ?? []).slice(0, MAX_SKIPPED_PATHS),
        }
      }),
    }
    return [200, payload]
  })

  const undoHandler = routeHandler(async (body: JsonBody): Promise<[number, unknown]> => {
    const sessionId = String(body.sessionId ?? '')
    const turn = Number(body.turn)
    if (sessionId.length === 0)
      return [400, { error: '缺少 sessionId' }]
    if (!Number.isInteger(turn) || turn <= 0)
      return [400, { error: 'turn 必须是正整数' }]
    const session = findSession(ctx, sessionId)
    if (session === undefined)
      return [404, { error: '会话不存在或尚未就绪' }]
    const probe = await probeWorkspace(sessionCwdOf(session))
    // 归属校验用当前 worktree 根；探测失败时传 null，由 service 层按账本判定。
    // 撤销与捕获共用同一队列，且该会话仍在跑时直接拒绝（after 快照尚未结算）。
    const isTurnPending = options.isTurnPending
    const outcome = await undoTurn({
      dshHome,
      sessionId,
      turn,
      currentWorkspace: probe.ok ? probe.root : null,
      queue,
      turnActive: isTurnPending === undefined ? live?.(sessionId).active === true : isTurnPending(sessionId, turn),
    })
    if (outcome.ok)
      return [200, { ok: true, restored: outcome.restored, removed: outcome.removed, failed: outcome.failed }]
    return [outcome.code, { error: outcome.error, conflicts: outcome.conflicts ?? [] }]
  }, { mutate: true })

  const liveHandler = routeHandler(async (_body: JsonBody, req: any): Promise<[number, unknown]> => {
    const url = new URL(req?.url ?? '/', 'http://localhost')
    const sessionId = String(url.searchParams.get('sessionId') ?? '')
    if (sessionId.length === 0)
      return [400, { error: '缺少 sessionId' }]
    // 只读宿主内存里的读数：客户端轮询频率与 git 调用频率解耦。
    const snapshot: LiveSnapshot = live?.(sessionId)
      ?? { active: false, turn: null, fileCount: 0, insertions: 0, deletions: 0 }
    return [200, snapshot]
  })

  return [
    { kind: 'exact', path: `${TURNREWIND_API_PREFIX}/summary`, handler: withConnectionAuth(connection, summaryHandler, TURNREWIND_PLUGIN_NAME) },
    { kind: 'exact', path: `${TURNREWIND_API_PREFIX}/live`, handler: withConnectionAuth(connection, liveHandler, TURNREWIND_PLUGIN_NAME) },
    { kind: 'exact', path: `${TURNREWIND_API_PREFIX}/undo`, handler: withConnectionAuth(connection, undoHandler, TURNREWIND_PLUGIN_NAME) },
  ]
}
