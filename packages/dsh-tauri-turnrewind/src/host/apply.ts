/**
 * host/apply.ts — turnrewind 插件装配（turn 生命周期接线 + HTTP 路由）。
 *
 * 装配顺序与原因：
 *   1. 捕获编排器先建（pre-step 到达时账本读写已就绪）；
 *   2. `agent/pre-step` 是唯一会 **await** 的钩子（执行屏障）；任何异常都吞掉后
 *      继续 `next()`——快照失败绝不能拦住用户的 turn（AGENTS.plugins.md 宿主侧规则）；
 *   3. `session/event` 的 turn/end、`agent/status → idle` 与 `session/disposed`
 *      在作废运行中读数（提示条状态）之后，只做后台结算转发；
 *   4. 路由注册在 effect 内，卸载统一释放；捕获编排器同样在 effect 内 dispose。
 */

import type { HostContext } from './types'
import { TURNREWIND_PLUGIN_NAME } from '../shared/constants'
import { createTurnRewindHooks } from './hooks'
import { buildRoutes } from './routes'
import { createTurnCapture } from './service/capture'
import { currentDshHome } from './service/ledger'
import { createWorkspaceQueue } from './service/queue'
import { sessionCwdOf } from './service/workspace'

/** 插件行配置（当前只有测试/调试用的数据目录覆盖）。 */
export interface PluginConfig {
  /** 覆盖宿主数据根目录（`$DSH_HOME`）；缺省走环境变量或 `~/.dsh`。 */
  dshHome?: string
}

/**
 * 插件体：注册 turn 生命周期钩子与 HTTP 路由。
 * @param ctx - 宿主根上下文（注入 webServer / sessions / agents）。
 * @param config - 插件行配置。
 */
export function apply(ctx: HostContext, config: PluginConfig = {}): void {
  const dshHome = typeof config?.dshHome === 'string' && config.dshHome.length > 0
    ? config.dshHome
    : currentDshHome()
  const hooks = createTurnRewindHooks()
  // 工作区级串行队列：捕获、结算、实时读数、容量治理与撤销共用同一实例，
  // 私有仓 index 因此不会出现两件 git 操作并发（见 service/queue.ts）。
  const queue = createWorkspaceQueue()
  const capture = createTurnCapture({
    dshHome,
    queue,
    logger: ctx.logger,
    onCaptured: (sessionId, turn, fileCount) => {
      void hooks.callHook('turn:captured', sessionId, turn, fileCount)
    },
  })

  // 1) 执行屏障：step === 1 时把 before 快照做在模型请求与工具执行之前。
  ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    try {
      const sessionId = payload?.agent?.session?.id
      if (payload?.step === 1 && typeof sessionId === 'string' && typeof payload?.turn === 'number')
        await capture.beginTurn(sessionId, payload.turn, sessionCwdOf(payload.agent.session))
    }
    catch (error) {
      ctx.logger?.warn?.(`${TURNREWIND_PLUGIN_NAME}: before snapshot failed: ${String(error)}`)
    }
    return next()
  })

  // 2) turn 落定后后台结算 after 快照 / 差异 / 账本（不阻塞 turn 边界）。
  ctx.on('session/event', (session: any, event: any) => {
    if (event?.type !== 'turn/end')
      return
    const turn = event?.data?.turn
    if (typeof session?.id !== 'string' || typeof turn !== 'number')
      return
    // 提示条读数在 turn 边界**同步**作废：结算是后台的（大仓库要几秒到几十秒），
    // 不能让它决定提示条什么时候消失，否则用户会一直看着上一轮的统计在变大。
    capture.resetLive(session.id, turn)
    void capture.settleTurn(session.id, turn).catch((error: unknown) => {
      ctx.logger?.warn?.(`${TURNREWIND_PLUGIN_NAME}: settle turn failed: ${String(error)}`)
    })
  })

  // 3) 兜底：被取消/中断而没走到 turn/end 的 turn，在会话空闲时结算。
  ctx.on('agent/status', (payload: any) => {
    if (payload?.status !== 'idle')
      return
    const sessionId = payload?.agent?.session?.id
    if (typeof sessionId !== 'string')
      return
    // 漏发 turn/end 的中断在这里收尾：同样立刻作废读数，提示条不跨轮残留。
    capture.resetLive(sessionId)
    void capture.settleIdle(sessionId).catch((error: unknown) => {
      ctx.logger?.warn?.(`${TURNREWIND_PLUGIN_NAME}: idle settle failed: ${String(error)}`)
    })
  })

  // 4) 会话结束（关闭/删除/应用退出）：整个会话的运行中读数归零，
  //    提示条不会带着上一轮的统计留到下次打开。
  ctx.on('session/disposed', (session: any) => {
    const sessionId = typeof session?.id === 'string' && session.id.length > 0 ? session.id : session?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      return
    capture.resetLive(sessionId)
  })

  // 5) HTTP 路由（客户端 UI 经此读摘要 / 运行中读数 / 执行撤销）。
  ctx.effect(() => {
    const disposers = buildRoutes(ctx, {
      dshHome,
      live: capture.liveState,
      isTurnPending: capture.isTurnPending,
      queue,
    }).map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers)
        dispose()
    }
  }, `${TURNREWIND_PLUGIN_NAME}: routes`)

  ctx.effect(() => () => capture.dispose(), `${TURNREWIND_PLUGIN_NAME}: turn capture`)
}
