/* eslint-disable no-control-regex */
import type { ReadinessPollResult, ReadinessProbeResult, StartupPhase } from './readiness'
import type { InternalPluginsPhasePayload, StartupError } from './types'
import { invoke } from '@tauri-apps/api/core'
import i18next from 'i18next'
import { containsInotifyLimitError, pickErrorLines } from '@/components/logs.utils'
import {
  HEALTH_PROBE_INITIAL_INTERVAL,
  HEALTH_PROBE_MAX_INTERVAL,
  LOG_TAIL_MAX_BYTES,
  STARTUP_INACTIVITY_TIMEOUT,
} from './constants'
import { pollReadiness } from './readiness'

/**
 * 服务生命周期的无状态辅助函数：URL 生成、健康探测、日志读取、错误装饰。
 *
 * 全部与 store 实例无关（不读 `this`、不写状态），因此从 store 中抽出，
 * 便于单独推理与复用；store 只保留编排逻辑。
 */

/**
 * 构建带时间戳的 iframe URL，避免 WebView2 缓存旧页面。
 * alpha 鉴权由启动前的桌面端 patch 处理，iframe 永远不携带启动 token；旧核心
 * 同样继续使用原有的缓存查询参数。
 */
export function generateTimestampedUrl(baseUrl: string): string {
  const timestamp = Date.now()
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}t=${timestamp}`
}

/** 通过 Rust 代理探测服务健康状态（超时 8s，网络抖动时重试） */
export async function checkHealthViaProxy(): Promise<ReadinessProbeResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('health check timeout')), 8000)
    })
    const resultPromise = invoke<string>('proxy_health_check')
    const result = await Promise.race([resultPromise, timeoutPromise])

    const lower = result.toLowerCase()
    if (lower.startsWith('healthy')) {
      console.warn('[Harness] health check passed:', result.split(' - <!doctype html>')[0])
      return {
        healthy: true,
        notOwned: false,
        phase: 'client-modules',
        reason: result,
      }
    }
    console.warn('[Harness] health check returned:', result)
    return {
      healthy: false,
      notOwned: false,
      phase: 'client-modules',
      reason: result,
    }
  }
  catch (err) {
    const message = String(err)
    if (message.includes('HARNESS_NOT_OWNED')) {
      // dsh 进程已退出（典型如插件冲突导致启动即崩溃），继续等只会白白耗完
      // 当前阶段 deadline，让调用方立刻结束并展示日志里的真实错误。
      console.warn('[Harness] dsh process exited during startup, failing fast')
      return {
        healthy: false,
        notOwned: true,
        phase: 'process-boot',
        reason: message,
      }
    }
    if (message.includes('502') || message.includes('Bad Gateway')) {
      console.warn('[Harness] transient 502 during health check, retrying')
    }
    else {
      // 单次探测失败是启动期的常态：服务尚未就绪、boot page 还是 404 等都会走到
      // 这里，而轮询会一直重试到该阶段 deadline；真正的失败由 startupError 以
      // errors.startup_* 报出。逐次记 ERROR 只会造成「满屏错误但其实启动正常」。
      console.warn('[Harness] health check failed, retrying:', err)
    }
    return {
      healthy: false,
      notOwned: false,
      phase: message.includes('client modules') || message.includes('client plugins')
        ? 'client-modules'
        : 'process-boot',
      reason: message,
    }
  }
  finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}

/** 按阶段 + 失败类型构造可展示的启动错误 */
export function startupError(
  phase: StartupPhase,
  reason: string,
  kind: 'failed' | 'inactivity' | 'absolute' | 'exited',
): StartupError {
  const phaseLabel = i18next.t(`startup.phase.${phase}`)
  const message = i18next.t(`errors.startup_${kind}`, {
    phase: phaseLabel,
    reason,
  })
  const error: StartupError = new Error(message)
  error.phase = phase
  error.lastReason = reason
  return error
}

/** 带退避的服务就绪轮询（探测实现固定为 Rust 代理健康检查） */
export function pollHarnessReadiness(
  absoluteTimeoutMs: number,
  shouldContinue: () => boolean,
  onProbe?: (result: ReadinessProbeResult) => void,
): Promise<ReadinessPollResult> {
  return pollReadiness({
    probe: checkHealthViaProxy,
    intervalMs: HEALTH_PROBE_INITIAL_INTERVAL,
    maxIntervalMs: HEALTH_PROBE_MAX_INTERVAL,
    backoffFactor: 1.5,
    inactivityTimeoutMs: STARTUP_INACTIVITY_TIMEOUT,
    absoluteTimeoutMs,
    shouldContinue,
    onProbe,
  })
}

/** 读取服务日志尾部（去掉 ANSI 转义与空行），启动失败时展示真实错误 */
export async function readServiceLogTail(): Promise<string[]> {
  try {
    const raw = await invoke<string>('read_service_logs', { maxBytes: LOG_TAIL_MAX_BYTES })
    return raw
      .split(/\r?\n/)
      .map(line => line.replace(/\x1B\[[0-9;]*m/g, '').trim())
      .filter(Boolean)
  }
  catch (err) {
    console.error('[Harness] failed to read service logs:', err)
    return []
  }
}

/** 失败时把服务日志的真实错误行与冲突提示挂到错误对象上 */
export async function attachStartupDiagnostics(err: unknown): Promise<StartupError> {
  // Tauri `invoke` 对 `Result<_, String>` 命令的 rejection 是裸字符串，
  // 必须先归一化为 Error 对象，否则在其上赋属性（ESM 严格模式）会抛
  // `TypeError: Cannot create property ... on string`，反而遮蔽真实错误。
  const diagnosed: StartupError = err instanceof Error ? err : new Error(String(err))
  if (!diagnosed.logs) {
    const lines = await readServiceLogTail()
    diagnosed.logLines = lines
    diagnosed.logs = pickErrorLines(lines)
    // 识别插件路由冲突（如 `duplicate prefix route "/sidebar/api"`），给出可操作的提示
    if (lines.join('\n').includes('duplicate prefix route')) {
      diagnosed.pluginConflictHint = i18next.t('errors.plugin_route_conflict')
    }
    // 识别 Linux inotify 文件监视上限（ENOSPC）：harness 服务启动即崩溃且用户无法直接解决，
    // 需要系统级调高 fs.inotify.max_user_watches（见 errors.inotify_limit 文案）
    if (containsInotifyLimitError(lines)) {
      diagnosed.inotifyLimitHint = i18next.t('errors.inotify_limit')
    }
  }
  return diagnosed
}

export type InternalPluginPhaseTranslate = (
  key: string,
  options?: Record<string, number>,
) => string

/**
 * 内部插件装载阶段 → 展示文案（`internal-plugins-phase` 事件驱动）。
 *
 * `heartbeat` 只是「仍在进行」的心跳，不改变文案，原样返回上一句，避免文案反复闪烁。
 */
export function internalPluginReason(
  payload: InternalPluginsPhasePayload,
  previousReason: string,
  translate: InternalPluginPhaseTranslate,
): string {
  switch (payload.detail) {
    case 'waiting':
      return translate('status.internal_waiting')
    case 'checking':
      return translate('status.internal_checking', { total: payload.total })
    case 'installing':
      return translate('status.internal_installing', { total: payload.total })
    case 'heartbeat':
      return previousReason
    case 'done':
      return translate('status.internal_done', { total: payload.total })
    case 'timeout':
      return translate('status.internal_timeout')
    case 'cancelled':
      return translate('status.internal_cancelled')
  }
}
