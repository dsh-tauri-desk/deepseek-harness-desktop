/**
 * host/routes/index.ts — 调度器 HTTP 路由（/api/dsh-scheduler/*）。
 *
 * 客户端 UI 经此调用：list / create / update / toggle / delete / run / history /
 * options。变更操作统一 routeHandler({ mutate: true })（POST + 仅 127.0.0.1 回环），
 * 并全部经 withConnectionAuth 做 DSH 连接信任边界校验。
 */

import type { SchedulerEngine } from '../service/scheduler.js'
import type { HostContext, JsonBody, RouteResult } from '../types/index.js'
import { routeHandler, withConnectionAuth } from 'dsh-tauri'
import { SCHEDULER_API_PREFIX } from '../../shared/constants.js'
import { createTask, deleteRun, deleteTask, listRuns, listTasks, recoverInterruptedRuns, setTaskEnabled, updateTask } from '../service/manager.js'
import { collectSchedulerOptions } from '../service/options.js'

/** 从 URL 或 body 提取参数（统一字符串化）。 */
function stringParam(body: JsonBody, url: URL, key: string): string {
  const value = url.searchParams.get(key) ?? body[key]
  return typeof value === 'string' ? value : ''
}

/** 构造全部路由（engine 由 apply 传入以支持手动触发）。 */
export function buildRoutes(ctx: HostContext, engine: SchedulerEngine): any[] {
  const routes = [
    {
      kind: 'exact',
      path: `${SCHEDULER_API_PREFIX}/tasks`,
      handler: routeHandler(async (body, req) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const search = stringParam(body, url, 'search')
        const all = listTasks()
        const tasks = search
          ? all.filter(task => task.name.toLowerCase().includes(search.toLowerCase()))
          : all
        return [200, { tasks }] as RouteResult
      }),
    },
    {
      kind: 'exact',
      path: `${SCHEDULER_API_PREFIX}/tasks/create`,
      handler: routeHandler(async (body) => {
        const result = await createTask(body as never)
        if (!result.ok)
          return [400, { error: result.error }] as RouteResult
        return [200, { ok: true, task: result.task }] as RouteResult
      }, { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SCHEDULER_API_PREFIX}/tasks/update`,
      handler: routeHandler(async (body) => {
        const id = stringParam(body, new URL('http://localhost'), 'id')
        if (!id)
          return [400, { error: '缺少任务 id' }] as RouteResult
        const result = await updateTask(id, body as never)
        if (!result.ok)
          return [400, { error: result.error }] as RouteResult
        return [200, { ok: true, task: result.task }] as RouteResult
      }, { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SCHEDULER_API_PREFIX}/tasks/toggle`,
      handler: routeHandler(async (body) => {
        const id = stringParam(body, new URL('http://localhost'), 'id')
        if (!id)
          return [400, { error: '缺少任务 id' }] as RouteResult
        const enabled = body.enabled === true
        const result = await setTaskEnabled(id, enabled)
        if (!result.ok)
          return [400, { error: result.error }] as RouteResult
        return [200, { ok: true, task: result.task }] as RouteResult
      }, { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SCHEDULER_API_PREFIX}/tasks/delete`,
      handler: routeHandler(async (body) => {
        const id = stringParam(body, new URL('http://localhost'), 'id')
        if (!id)
          return [400, { error: '缺少任务 id' }] as RouteResult
        const result = await deleteTask(id)
        if (!result.ok)
          return [400, { error: result.error }] as RouteResult
        return [200, { ok: true }] as RouteResult
      }, { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SCHEDULER_API_PREFIX}/tasks/run`,
      handler: routeHandler(async (body) => {
        const id = stringParam(body, new URL('http://localhost'), 'id')
        if (!id)
          return [400, { error: '缺少任务 id' }] as RouteResult
        const result = await engine.runNow(id)
        if (!result.ok)
          return [400, { error: result.error }] as RouteResult
        return [200, { ok: true }] as RouteResult
      }, { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SCHEDULER_API_PREFIX}/history/delete`,
      handler: routeHandler(async (body) => {
        const id = stringParam(body, new URL('http://localhost'), 'id')
        if (!id)
          return [400, { error: '缺少执行记录 id' }] as RouteResult
        const result = await deleteRun(id)
        if (!result.ok)
          return [400, { error: result.error }] as RouteResult
        return [200, { ok: true }] as RouteResult
      }, { mutate: true }),
    },
    {
      kind: 'exact',
      path: `${SCHEDULER_API_PREFIX}/history`,
      handler: routeHandler(async (body, req) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const taskId = stringParam(body, url, 'taskId') || undefined
        const runs = listRuns(taskId)
        return [200, { runs }] as RouteResult
      }),
    },
    {
      kind: 'exact',
      path: `${SCHEDULER_API_PREFIX}/options`,
      handler: routeHandler(async () => {
        const options = await collectSchedulerOptions(ctx)
        return [200, options] as RouteResult
      }),
    },
    {
      kind: 'exact',
      path: `${SCHEDULER_API_PREFIX}/recover`,
      handler: routeHandler(async () => {
        await recoverInterruptedRuns()
        return [200, { ok: true }] as RouteResult
      }, { mutate: true }),
    },
  ]
  return routes.map(route => ({
    ...route,
    handler: withConnectionAuth(ctx.connection, route.handler, 'dsh-tauri-panel-scheduler'),
  }))
}
