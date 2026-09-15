import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * 宿主自报协议请求体上限（1 MiB）。
 *
 * 由 `defineRoutes` 用 h3 内置的 `bodyLimit` 中间件挂在路由表之前：超过上限的请求
 * 在 handler 读取请求体时以 413 结束，而不是先整份读进内存再判定。
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024
