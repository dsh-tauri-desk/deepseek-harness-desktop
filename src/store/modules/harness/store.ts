/* eslint-disable no-control-regex */
import type { UnlistenFn } from '@tauri-apps/api/event'
import type {
  HarnessProcessExitedPayload,
  InstallerState,
  InstallProgress,
  InternalPluginsPhasePayload,
  PluginRecoveryInfo,
  PreinstallLogPayload,
  PreinstallPlugin,
  RecoveryState,
  SetupStatus,
  SidebarBusyAction,
} from './types'
import type { ReadinessPollResult, ReadinessProbeResult, StartupPhase } from '@/utils/readiness'
import { emitter } from '@hairy/react-lib'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { queryClient } from '@/config/client'
import { internalPluginReason } from '@/utils/internal-plugin-phase'
import { containsInotifyLimitError, pickErrorLines } from '@/utils/log'
import { BoundedReloadGate, pollReadiness, SingleFlight, waitForActivityTask } from '@/utils/readiness'
import { runtimeExitMessageKey, shouldAcceptRuntimeExit } from '@/utils/runtime-exit'
import { harnessUpdater } from '../harness-updater'

const IFRAME_LOAD_TIMEOUT = 20000
const HEALTH_PROBE_INITIAL_INTERVAL = 1000
const HEALTH_PROBE_MAX_INTERVAL = 5000
const STARTUP_INACTIVITY_TIMEOUT = 180000
const STARTUP_ABSOLUTE_TIMEOUT = 300000
const PLUGIN_INACTIVITY_TIMEOUT = 30000
const PLUGIN_ABSOLUTE_TIMEOUT = 600000
const PLUGIN_ACTIVITY_CHECK_INTERVAL = 1000
const IFRAME_RECOVERY_ABSOLUTE_TIMEOUT = 60000
/** 启动失败时从服务日志尾部挑选的原始行上限（ANSI 清洗后按行截断） */
const LOG_TAIL_MAX_BYTES = 16 * 1024

/** 启动失败错误：附带从 dsh 服务日志中读取的真实错误行与可选的冲突提示 */
interface StartupError extends Error {
  logs?: string[]
  /** 完整清洗后的日志尾（供插件异常定位使用，非仅错误行） */
  logLines?: string[]
  pluginConflictHint?: string
  /** Linux inotify 文件监视上限（ENOSPC）导致服务启动即崩溃时的针对性提示 */
  inotifyLimitHint?: string
  phase?: StartupPhase
  lastReason?: string
}

const initialInstaller: InstallerState = {
  title: '',
  detail: '',
  percentage: 0,
  logs: [],
}

const initialRecovery: RecoveryState = {
  required: false,
  info: null,
  attempts: 0,
  busy: false,
}

/** 启动流程令牌：boot 并发/重复调用时只采纳最后一次的结果 */
let bootToken = 0
/** 最终健康复核到 ready 提交之间的启动代；退出事件可使该提交失效。 */
let readinessCommitToken: number | null = null
/** 首次自动启动去重（React StrictMode 会重复挂载 effect） */
let bootStarted = false
let pluginActivitySequence = 0
let pluginActivityReason = ''
const restartFlight = new SingleFlight<void>()
const iframeReloadGate = new BoundedReloadGate(3)
let iframeRefreshTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 构建带时间戳的 iframe URL，避免 WebView2 缓存旧页面。
 * alpha 鉴权由启动前的桌面端 patch 处理，iframe 永远不携带启动 token；旧核心
 * 同样继续使用原有的缓存查询参数。
 */
function generateTimestampedUrl(baseUrl: string): string {
  const timestamp = Date.now()
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}t=${timestamp}`
}

/** 通过 Rust 代理探测服务健康状态（超时 8s，网络抖动时重试） */
async function checkHealthViaProxy(): Promise<ReadinessProbeResult> {
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
      console.error('[Harness] health check failed:', err)
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

function startupError(phase: StartupPhase, reason: string, kind: 'failed' | 'inactivity' | 'absolute' | 'exited'): StartupError {
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

function pollHarnessReadiness(
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
async function readServiceLogTail(): Promise<string[]> {
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
async function attachStartupDiagnostics(err: unknown): Promise<StartupError> {
  // Tauri `invoke` 对 `Result<_, String>` 命令的 rejection 是裸字符串，
  // 必须先归一化为 Error 对象，否则在其上赋属性（ESM 严格模式）会抛
  // `TypeError: Cannot create property ... on string`，反而遮蔽真实错误。
  const startupError: StartupError = err instanceof Error ? err : new Error(String(err))
  if (!startupError.logs) {
    const lines = await readServiceLogTail()
    startupError.logLines = lines
    startupError.logs = pickErrorLines(lines)
    // 识别插件路由冲突（如 `duplicate prefix route "/sidebar/api"`），给出可操作的提示
    if (lines.join('\n').includes('duplicate prefix route')) {
      startupError.pluginConflictHint = i18next.t('errors.plugin_route_conflict')
    }
    // 识别 Linux inotify 文件监视上限（ENOSPC）：harness 服务启动即崩溃且用户无法直接解决，
    // 需要系统级调高 fs.inotify.max_user_watches（见 errors.inotify_limit 文案）
    if (containsInotifyLimitError(lines)) {
      startupError.inotifyLimitHint = i18next.t('errors.inotify_limit')
    }
  }
  return startupError as StartupError
}

/**
 * 桌面外壳核心业务模块：安装/启动流程、服务生命周期（启动/健康检查/重启/停止）、
 * iframe 加载状态与挂起兜底。
 *
 * 拆分说明（参考 damn-reports 的 store 组织方式）：
 * 版本更新与下载完成提示分别收敛到 updater / download 模块，
 * 本模块专注服务生命周期与页面加载状态。
 */
export const harness = defineStore({
  state: () => ({
    status: 'ready' as SetupStatus,
    installer: initialInstaller,
    errorMsg: '',
    /** 启动失败时从 dsh 服务日志中读取的真实错误行（Loadable 错误态日志面板） */
    errorLogs: [] as string[],
    /** 识别到插件路由冲突时的针对性提示（Loadable children 展示） */
    pluginConflictHint: '',
    /** 识别到 Linux inotify 文件监视上限（ENOSPC）时的针对性提示（Loadable children 展示） */
    inotifyLimitHint: '',
    /** 插件异常修复界面状态（启动崩溃/运行期异常 → 弹出「卸除此插件并继续检测」） */
    recovery: initialRecovery,
    /** 用户已「暂不处理」的插件 id（避免同一运行期异常反复弹窗） */
    dismissedRecoveryIds: [] as string[],
    /** 预装插件引导状态：列表/安装进度/日志/错误 */
    preinstall: {
      plugins: [] as PreinstallPlugin[],
      loading: false,
      installing: false,
      /** 用户触发了“取消”但仍需等后端结束进程树 */
      cancelling: false,
      logs: [] as string[],
      /** 安装失败错误（区别于下面列表加载失败） */
      error: '',
      /** 拉取预装插件列表失败（区别于空列表；UI 据此展示错误态 + 重试） */
      loadError: '',
      /** 是否为首次安装引导（决定默认勾选策略）：boot 流程进入时为 true，侧边栏手动打开为 false */
      isFirstTime: true,
    },
    serviceUrl: 'http://127.0.0.1:3080',
    /** 带时间戳的 iframe 地址（boot 时生成一次，避免缓存） */
    iframeSrc: '',
    iframeLoaded: false,
    iframeError: false,
    iframeKey: 0,
    serviceHealthy: false,
    serviceRunning: false,
    startupPhase: 'plugin-install' as StartupPhase,
    startupReason: '',
    busyAction: null as SidebarBusyAction,
  }),
  actions: {
    /** 首次挂载时自动启动（StrictMode 重复挂载下保证只执行一次） */
    startup() {
      if (bootStarted)
        return
      bootStarted = true
      void this.initialize()
    },

    async initialize() {
      await Promise.all([
        this.listenPluginRecovery(),
        this.listenInternalPhase(),
        this.listenProcessExit(),
      ])
      await this.boot()
    },

    /** 订阅当前持有的 Harness 根进程退出事件，及时撤下失效 iframe。 */
    async listenProcessExit() {
      try {
        await listen<HarnessProcessExitedPayload>('harness-process-exited', (event) => {
          void this.handleProcessExit(event.payload)
        })
      }
      catch (err) {
        console.error('[Harness] failed to listen harness-process-exited:', err)
      }
    },

    /**
     * 处理运行期退出：先通过 ownership-aware 健康代理确认事件仍属于当前代，
     * 避免延迟事件覆盖已重启的新进程；确认后使旧启动链失效并展示可重试错误页。
     */
    async handleProcessExit(payload: HarnessProcessExitedPayload) {
      const observedToken = bootToken
      if (!shouldAcceptRuntimeExit({
        serviceHealthy: this.serviceHealthy,
        serviceRunning: this.serviceRunning,
        readinessCommitPending: readinessCommitToken === observedToken,
        busyAction: this.busyAction,
        observedToken,
        currentToken: bootToken,
        notOwned: true,
      })) {
        return
      }

      const probe = await checkHealthViaProxy()
      if (!shouldAcceptRuntimeExit({
        serviceHealthy: this.serviceHealthy,
        serviceRunning: this.serviceRunning,
        readinessCommitPending: readinessCommitToken === observedToken,
        busyAction: this.busyAction,
        observedToken,
        currentToken: bootToken,
        notOwned: probe.notOwned,
      })) {
        return
      }

      const exitToken = ++bootToken
      const message = i18next.t(runtimeExitMessageKey(payload.exitCode), {
        code: payload.exitCode,
      })
      let exitDetail = '(exit code unavailable)'
      if (payload.exitCode != null)
        exitDetail = `(exit code ${payload.exitCode})`
      console.warn(
        `[Harness] owned process ${payload.pid} exited unexpectedly`,
        exitDetail,
      )
      iframeReloadGate.reset()
      if (iframeRefreshTimer !== undefined) {
        clearTimeout(iframeRefreshTimer)
        iframeRefreshTimer = undefined
      }
      this.serviceHealthy = false
      this.iframeLoaded = false
      this.iframeError = false
      this.fail(message)

      const error = await attachStartupDiagnostics(new Error(message))
      if (exitToken !== bootToken)
        return
      await this.reviewStartupRecovery(error.logLines ?? error.logs ?? [], exitToken)
      if (exitToken !== bootToken)
        return
      this.fail(
        error.message,
        error.logs,
        error.pluginConflictHint,
        error.inotifyLimitHint,
      )
    },

    /**
     * 订阅后端「插件异常」推送：`report_plugin_error`（运行期异常）会推送
     * `plugin-recovery-required`，据此弹出「卸除此插件并继续检测」修复界面。
     */
    async listenPluginRecovery() {
      try {
        await listen<PluginRecoveryInfo>('plugin-recovery-required', (event) => {
          this.setRuntimeRecovery(event.payload)
        })
      }
      catch (err) {
        console.error('[Harness] failed to listen plugin-recovery-required:', err)
      }
    },

    /**
     * 订阅后端「内置插件核对阶段」推送：`internal-plugins-phase` 事件
     * （loading / progress / done），加载屏据此在「Loading internal plugins…」与
     * 「Loading plugins…」之间切换。事件在服务启动前发出，健康轮询期间到达。
     */
    async listenInternalPhase() {
      try {
        await listen<InternalPluginsPhasePayload>('internal-plugins-phase', (event) => {
          const payload = event.payload
          pluginActivitySequence++
          pluginActivityReason = internalPluginReason(
            payload,
            pluginActivityReason,
            (key, options) => i18next.t(key, options),
          )
          if (payload.phase !== 'done') {
            this.startupPhase = 'plugin-install'
            this.startupReason = pluginActivityReason
          }
        })
      }
      catch (err) {
        console.error('[Harness] failed to listen internal-plugins-phase:', err)
      }
    },

    /** 刷新 iframe：清除加载态并延迟重新挂载 */
    refreshIframe() {
      this.iframeLoaded = false
      this.iframeError = false
      if (iframeRefreshTimer !== undefined) {
        clearTimeout(iframeRefreshTimer)
      }
      iframeRefreshTimer = setTimeout(() => {
        iframeRefreshTimer = undefined
        this.iframeKey++
      }, 800)
    },

    /** iframe 加载成功/失败时由视图回调更新状态 */
    markIframeLoaded() {
      this.iframeLoaded = true
      this.iframeError = false
    },

    markIframeError() {
      this.iframeError = true
      this.iframeLoaded = false
    },

    markIframeBootReady() {
      iframeReloadGate.markReady()
      if (iframeRefreshTimer !== undefined) {
        clearTimeout(iframeRefreshTimer)
        iframeRefreshTimer = undefined
      }
    },

    async recoverIframeBoot() {
      const generation = this.iframeKey
      const decision = iframeReloadGate.request(generation)
      if (decision === 'duplicate' || decision === 'ready')
        return
      if (decision === 'exhausted') {
        const reason = i18next.t('errors.client_boot_stalled')
        const error = startupError('client-modules', reason, 'absolute')
        this.fail(error.message, undefined, undefined, undefined, this.serviceRunning)
        return
      }

      const result = await pollHarnessReadiness(
        IFRAME_RECOVERY_ABSOLUTE_TIMEOUT,
        () => generation === this.iframeKey && this.serviceRunning,
      )
      if (generation !== this.iframeKey || !this.serviceRunning)
        return
      if (result.healthy) {
        this.refreshIframe()
        return
      }

      const phase = result.phase ?? 'client-modules'
      const reason = result.reason ?? i18next.t('errors.no_readiness_reason')
      const kind = result.notOwned ? 'exited' : result.timeout ?? 'failed'
      const error = startupError(phase, reason, kind)
      this.fail(error.message, undefined, undefined, undefined, !result.notOwned)
    },

    /** 安装进度流：只前进不后退，供首次安装/手动更新共用 */
    async listenInstallProgress(): Promise<UnlistenFn> {
      return listen<InstallProgress>('install-progress', (e) => {
        const payload = e.payload
        if (payload.percentage < this.installer.percentage) {
          return
        }
        const logs = payload.log
          ? [...this.installer.logs, payload.log].slice(-5)
          : this.installer.logs
        this.installer = {
          title: payload.title || this.installer.title,
          detail: payload.detail || this.installer.detail,
          percentage: payload.percentage,
          logs,
        }
      })
    },

    /** 服务探测通过后的统一收尾；token 用于阻止旧启动流程覆盖新状态 */
    async completeReadiness(token: number): Promise<boolean> {
      if (token !== bootToken)
        return false

      // poll 通过与 ready 提交之间仍可能退出。进入提交窗口后再复核一次 ownership，
      // 既能捕获窗口开启前已丢失的退出事件，也让窗口内事件用 token 中止本次提交。
      const finalProbe = await checkHealthViaProxy()
      if (token !== bootToken)
        return false
      // 上一轮 poll 已确认就绪；这里只让 ownership 丢失推翻结果，短暂探测失败不降级。
      if (finalProbe.notOwned) {
        this.serviceRunning = false
        const phase = finalProbe.phase ?? this.startupPhase
        const reason = finalProbe.reason ?? (this.startupReason || i18next.t('errors.no_readiness_reason'))
        throw startupError(phase, reason, 'exited')
      }

      const readyInfo = await invoke<{ service_url: string }>('get_runtime_info')
      if (token !== bootToken)
        return false

      this.serviceUrl = readyInfo.service_url
      this.iframeSrc = generateTimestampedUrl(readyInfo.service_url)
      this.serviceHealthy = true
      this.serviceRunning = true
      this.status = 'ready'
      this.errorMsg = ''
      this.errorLogs = []
      this.pluginConflictHint = ''
      this.inotifyLimitHint = ''
      this.preinstall.error = ''
      // 服务（重）启动成功：清空插件异常修复态（若曾进入），并重置已「暂不处理」的插件
      this.recovery = { required: false, info: null, attempts: 0, busy: false }
      this.dismissedRecoveryIds = []
      iframeReloadGate.reset()
      if (iframeRefreshTimer !== undefined) {
        clearTimeout(iframeRefreshTimer)
        iframeRefreshTimer = undefined
      }
      // 服务（重）启动成功后，dsh 版本/端口/CLI 链接状态等运行时信息可能已变化
      // （典型：Harness 更新后旧版本缓存仍在，调试侧边栏需刷新页面才显示新版本）。
      // 使侧边栏相关查询缓存失效，重新打开/已挂载时自动拉取最新值。
      void queryClient.invalidateQueries({ queryKey: ['info'] })
      void queryClient.invalidateQueries({ queryKey: ['config'] })
      void queryClient.invalidateQueries({ queryKey: ['cli_status'] })
      // 档案/核心切换后重启：当前档案的插件列表、核心来源状态一并刷新
      void queryClient.invalidateQueries({ queryKey: ['plugins'] })
      void queryClient.invalidateQueries({ queryKey: ['profiles'] })
      void queryClient.invalidateQueries({ queryKey: ['cores'] })
      return true
    },

    /** 拉起服务并等待健康检查通过，通过后才允许挂载 iframe */
    async launchAndWait(token?: number) {
      this.status = 'ready'
      this.installer = initialInstaller
      this.errorMsg = ''
      this.errorLogs = []
      this.pluginConflictHint = ''
      this.inotifyLimitHint = ''
      this.recovery = initialRecovery
      this.dismissedRecoveryIds = []
      this.serviceHealthy = false
      this.iframeLoaded = false
      this.iframeError = false
      this.startupPhase = 'process-boot'
      this.startupReason = i18next.t('status.loading_process')
      try {
        await invoke('launch_harness')
        this.serviceRunning = true
        this.startupPhase = 'process-boot'
        this.startupReason = i18next.t('status.loading_process')
        // 后端遇到端口占用时会自动递增并持久化端口，启动后重新读取真实地址。
        const runtimeInfo = await invoke<{ service_url: string }>('get_runtime_info')
        this.serviceUrl = runtimeInfo.service_url
        this.iframeSrc = generateTimestampedUrl(runtimeInfo.service_url)

        const result = await pollHarnessReadiness(
          STARTUP_ABSOLUTE_TIMEOUT,
          () => token === undefined || token === bootToken,
          (probe) => {
            if (probe.phase) {
              this.startupPhase = probe.phase
            }
            this.startupReason = probe.reason ?? ''
          },
        )
        if (token !== undefined && token !== bootToken) {
          return
        }
        if (!result.healthy) {
          const phase = result.phase ?? this.startupPhase
          const reason = result.reason ?? (this.startupReason || i18next.t('errors.no_readiness_reason'))
          if (result.notOwned) {
            this.serviceRunning = false
            throw startupError(phase, reason, 'exited')
          }
          if (result.timeout) {
            throw startupError(phase, reason, result.timeout)
          }
          throw startupError(phase, reason, 'failed')
        }
        // 服务已就绪后再取一次真实地址：`launch_harness` 可能因后端已在并发拉起
        // （auto_start）而提前返回，此刻端口若尚未落库，上面读到的 service_url 会是
        // 旧端口；健康检查通过意味着服务已在最终端口就绪，此时读取必然准确。
        // 避免 iframe 挂载到一个无人监听的地址（表现为首次加载失败、刷新后恢复）。
        const readinessToken = token ?? bootToken
        readinessCommitToken = readinessToken
        try {
          await this.completeReadiness(readinessToken)
        }
        finally {
          if (readinessCommitToken === readinessToken)
            readinessCommitToken = null
        }
      }
      catch (err) {
        // 失败时附上服务日志里的真实错误行，供错误界面展示而不是只显示超时文案
        throw await attachStartupDiagnostics(err)
      }
    },

    /** 启动流程：检测环境/安装依赖 → 拉起服务 → 已安装时后台检查更新 */
    async boot() {
      const token = ++bootToken
      iframeReloadGate.reset()
      if (iframeRefreshTimer !== undefined) {
        clearTimeout(iframeRefreshTimer)
        iframeRefreshTimer = undefined
      }
      // 回到加载态：已安装时不再显示检测/启动界面，直接进入页面加载状态
      this.serviceHealthy = false
      this.iframeLoaded = false
      this.iframeError = false
      // 重新启动/进入启动流程时先退出上一轮的错误与修复态（重启可能由插件修复、
      // 配置切换触发），避免旧的「启动失败 / Preview」等信息在启动期间闪现。
      // 注意：保留 attempts 计数，连续失败仍能命中「频繁失败」提示。
      this.errorMsg = ''
      this.errorLogs = []
      this.pluginConflictHint = ''
      this.inotifyLimitHint = ''
      this.recovery = { required: false, info: null, attempts: this.recovery.attempts, busy: false }
      this.status = 'ready'
      let unlistenInstall: UnlistenFn | null = null

      try {
        // 事件监听失败（例如 IPC 自定义协议被 CSP 拦截、回退 postMessage 也异常）
        // 不应阻断启动流程，因此容错跳过。
        try {
          unlistenInstall = await this.listenInstallProgress()
        }
        catch (err) {
          console.error('[Harness] failed to listen install-progress:', err)
        }
        const runtimeInfo = await invoke<{ service_url: string }>('get_runtime_info')
        this.serviceUrl = runtimeInfo.service_url
        this.iframeSrc = generateTimestampedUrl(runtimeInfo.service_url)

        // 已安装过则跳过安装界面，避免每次启动都闪现"正在安装依赖..."
        const config = await invoke<{
          installed: boolean
        }>('get_app_config')

        // 每次启动都做纯本地运行时检查：旧版本升级后 installed 仍为 true，但新版
        // 可能新增依赖（如 Windows 空白环境需要的 MinGit），必须进入幂等自愈。
        // 已全部就绪时不调用安装命令，因此不会联网，也不会闪现安装界面。
        const ready = await invoke<boolean>('runtime_ready')
        if (!ready || !config.installed) {
          if (!ready) {
            this.status = 'installing'
            this.installer = { ...initialInstaller, title: i18next.t('status.installing') }
          }
          await invoke('install_dependencies')
        }

        // 内置插件自愈是独立、显式且有界的启动阶段。后端 heartbeat 只延长无活动
        // deadline，绝对上限不会延长；旧启动 token 失效时立即停止采纳结果。
        this.startupPhase = 'plugin-install'
        this.startupReason = i18next.t('status.loading_internal')
        pluginActivitySequence++
        pluginActivityReason = i18next.t('status.internal_waiting')
        try {
          const result = await waitForActivityTask({
            task: invoke('ensure_internal_plugins'),
            getActivity: () => ({
              sequence: pluginActivitySequence,
              reason: pluginActivityReason,
            }),
            inactivityTimeoutMs: PLUGIN_INACTIVITY_TIMEOUT,
            absoluteTimeoutMs: PLUGIN_ABSOLUTE_TIMEOUT,
            intervalMs: PLUGIN_ACTIVITY_CHECK_INTERVAL,
            shouldContinue: () => token === bootToken,
          })
          if (result.cancelled) {
            return
          }
          if (result.timeout) {
            try {
              // 后端只在所属进程树已退出、共享 flight 已释放后返回；在此之前不
              // 进入失败态，避免用户立即 Retry 订阅到上一轮 cancelled 结果。
              await invoke('cancel_internal_plugins')
            }
            catch (cancelError) {
              console.error('[Harness] failed to cancel timed-out internal plugin install:', cancelError)
              throw startupError('plugin-install', String(cancelError), 'failed')
            }
            throw startupError('plugin-install', result.reason, result.timeout)
          }
        }
        catch (err) {
          if (err instanceof Error && (err as StartupError).phase) {
            throw err
          }
          throw startupError('plugin-install', String(err), 'failed')
        }
        // 预装插件引导：首次安装、老版本升级（无指纹基线）或 preset-plugins.json
        // 内容变更（社区新增推荐插件）时重新进入预设流程，装完/跳过后才拉起服务。
        // preset-plugins.json 随安装包发布、每次安装被强制覆盖，旧文件不可比对，
        // 由 Rust 侧记录内容指纹到 app-data（.store.dat），启动时比对是否有变更。
        if (await invoke<boolean>('get_preinstall_pending')) {
          this.status = 'preinstall'
          this.preinstall.isFirstTime = true
          await this.loadPreinstallPlugins()
          return
        }

        await this.launchAndWait(token)

        if (token !== bootToken)
          return
        // 已安装时后台静默检查新版，发现后提示用户
        if (config.installed) {
          void harnessUpdater.checkForUpdate()
        }
      }
      catch (err) {
        if (token !== bootToken)
          return
        console.error('[Harness] startup failed:', err)
        const startupError = await attachStartupDiagnostics(err)
        // 尝试从日志定位问题插件：能定位则弹出修复界面（全屏恢复页）
        await this.reviewStartupRecovery(startupError.logLines ?? startupError.logs ?? [])
        this.fail(
          startupError.message,
          startupError.logs,
          startupError.pluginConflictHint,
          startupError.inotifyLimitHint,
          this.serviceRunning,
        )
      }
      finally {
        unlistenInstall?.()
      }
    },

    /** 进入安装态（手动更新前复用，标题区分"安装/更新"） */
    prepareInstall(title: string) {
      this.status = 'installing'
      this.installer = { ...initialInstaller, title }
    },

    /** 进入错误态（供本模块与 updater 模块共用） */
    fail(message: string, logs?: string[], pluginConflictHint?: string, inotifyLimitHint?: string, keepServiceRunning = false) {
      this.errorMsg = message
      this.errorLogs = logs ?? []
      this.pluginConflictHint = pluginConflictHint ?? ''
      this.inotifyLimitHint = inotifyLimitHint ?? ''
      this.status = 'error'
      this.serviceRunning = keepServiceRunning
    },

    /**
     * 启动失败时尝试定位问题插件并弹出修复界面。
     * 能定位到具体插件 → 设置 `recovery`；定位不到则保持普通错误态（无插件可卸载）。
     */
    async reviewStartupRecovery(logs: string[], token?: number) {
      if (this.recovery.required || logs.length === 0)
        return
      try {
        const info = await invoke<PluginRecoveryInfo>('detect_plugin_recovery', { logs })
        if (token !== undefined && token !== bootToken)
          return
        if (info.plugins.length > 0) {
          this.recovery = {
            required: true,
            info,
            attempts: this.recovery.attempts + 1,
            busy: false,
          }
        }
      }
      catch (err) {
        console.error('[Harness] detect_plugin_recovery failed:', err)
      }
    },

    /** 运行期插件异常：弹出修复对话框（应用仍在运行）。已「暂不处理」的同插件不再重复弹。 */
    setRuntimeRecovery(info: PluginRecoveryInfo) {
      if (info.plugins.length === 0)
        return
      if (info.plugins.some(id => this.dismissedRecoveryIds.includes(id)))
        return
      this.recovery = {
        required: true,
        info,
        attempts: this.recovery.attempts + 1,
        busy: false,
      }
    },

    /** 「卸除此插件并继续检测」：离线卸载定位到的插件 → 重启并重新检测；仍有问题会再次触发修复界面。 */
    async recoverAndRedetect(ids: readonly string[]) {
      if (this.recovery.busy || ids.length === 0)
        return
      this.recovery = { ...this.recovery, busy: true }
      try {
        for (const id of ids) {
          await invoke('recover_plugin', { id })
        }
        // 卸载成功：清空恢复态回到启动/就绪；若仍失败，boot 的 catch 会再次定位并弹出。
        // 保留 attempts：连续失败会累加，达到上限后界面提示「查看日志 / 手动卸载」。
        this.dismissedRecoveryIds = this.dismissedRecoveryIds.filter(x => !ids.includes(x))
        this.recovery = { required: false, info: null, attempts: this.recovery.attempts, busy: false }
        await this.restart()
      }
      catch (err) {
        console.error('[Harness] recover_plugin failed:', err)
        this.recovery = { ...this.recovery, busy: false, attempts: this.recovery.attempts + 1 }
      }
    },

    /** 从快照还原并继续检测：优先用单插件快照还原问题插件（优先级高于卸载）；
     * 无快照的插件保持不动，避免误删。还原成功后重启并重新检测。 */
    async restoreAndRedetect(ids: readonly string[]) {
      if (this.recovery.busy || ids.length === 0)
        return
      this.recovery = { ...this.recovery, busy: true }
      try {
        for (const id of ids) {
          await invoke('restore_plugin', { id })
        }
        this.recovery = { required: false, info: null, attempts: this.recovery.attempts, busy: false }
        await this.restart()
      }
      catch (err) {
        console.error('[Harness] restore_plugin failed:', err)
        this.recovery = { ...this.recovery, busy: false, attempts: this.recovery.attempts + 1 }
      }
    },

    /** 「暂不处理」：关闭修复界面并记住这些插件（运行期场景不阻断使用）。 */
    dismissRecovery() {
      if (this.recovery.info) {
        this.dismissedRecoveryIds = [
          ...new Set([...this.dismissedRecoveryIds, ...this.recovery.info.plugins]),
        ]
      }
      this.recovery = { required: false, info: null, attempts: 0, busy: false }
    },

    /** 重启服务：先强杀再拉起，最终回到就绪/错误态 */
    restart(): Promise<void> {
      return restartFlight.run(async () => {
        if (this.busyAction)
          return
        this.busyAction = 'restart'
        // 重启旧进程前先撤下旧 iframe；这样延迟到达的旧进程退出事件不会被
        // 误当成新一代启动失败。新进程通过 completeReadiness 后再恢复 healthy。
        this.serviceHealthy = false
        this.iframeLoaded = false
        this.iframeError = false
        // 手动重启（含修复界面上的「重启 Harness」）：先退出恢复态，
        // 若重启仍失败，boot 的 catch 会重新定位问题插件并再次弹出。
        this.recovery = { ...this.recovery, required: false, busy: false }
        try {
          emitter.emit('config:dialog:hidden')
          await invoke('shutdown_harness')
        }
        catch (err) {
          console.error('[Harness] shutdown during restart failed:', err)
        }
        this.serviceRunning = false
        try {
          await this.boot()
        }
        finally {
          this.busyAction = null
        }
      })
    },

    /** 停止服务并回到停止态界面 */
    async shutdown() {
      if (this.busyAction)
        return
      this.busyAction = 'shutdown'
      // 停止服务后应用回到「已停止」态，配置弹窗已无意义，与 restart 一致地关闭它
      emitter.emit('config:dialog:hidden')
      try {
        await invoke('shutdown_harness')
      }
      catch (err) {
        console.error('[Harness] shutdown failed:', err)
      }
      finally {
        this.busyAction = null
      }
      this.serviceRunning = false
      this.status = 'error'
      this.errorMsg = i18next.t('ui.stopped')
      this.errorLogs = []
      this.pluginConflictHint = ''
      this.inotifyLimitHint = ''
      this.recovery = initialRecovery
      this.dismissedRecoveryIds = []
    },

    /** 服务未运行时点击"重试"：重新拉起服务并等待健康检查 */
    async start() {
      if (this.busyAction)
        return
      this.busyAction = 'start'
      try {
        await this.boot()
      }
      finally {
        this.busyAction = null
      }
    },

    /** 在系统浏览器中打开服务地址 */
    async openBrowser() {
      if (this.busyAction)
        return
      this.busyAction = 'openBrowser'
      try {
        await invoke('open_in_browser')
      }
      catch (err) {
        console.error('[Harness] open in browser failed:', err)
      }
      finally {
        this.busyAction = null
      }
    },

    /** 拉取预装插件列表（含已安装检测），供首次启动引导界面渲染 */
    async loadPreinstallPlugins(): Promise<PreinstallPlugin[]> {
      if (this.preinstall.loading)
        return this.preinstall.plugins
      this.preinstall.loading = true
      try {
        this.preinstall.plugins = await invoke<PreinstallPlugin[]>('get_preinstall_plugins')
        // 成功加载后清除历史加载错误，避免残留错误态遮蔽新列表
        this.preinstall.loadError = ''
      }
      catch (err) {
        console.error('[Harness] failed to load preinstall plugins:', err)
        // 记录错误而非伪装空列表：UI 据此展示错误态与重试按钮
        this.preinstall.loadError = String(err)
      }
      finally {
        this.preinstall.loading = false
      }
      return this.preinstall.plugins
    },

    /** 预装安装日志流：dsh plugin 进程输出逐行追加 */
    async listenPreinstallLog(): Promise<UnlistenFn> {
      return listen<PreinstallLogPayload>('preinstall-log', (e) => {
        this.preinstall.logs = [...this.preinstall.logs, e.payload.line].slice(-200)
      })
    },

    /**
     * 确认安装/卸载预装插件：流式日志，完成后继续启动服务。
     *
     * 前端传入 diff 结果（installIds = 新增勾选需安装；uninstallIds = 取消勾选需卸载），
     * 无变化时两者均为空，后端直接标记完成。
     */
    async confirmPreinstall(input: { installIds?: string[], uninstallIds?: string[] } | string[]) {
      // 兼容旧调用方（直接传数组）与新调用方（传 {installIds, uninstallIds}）
      const installIds = Array.isArray(input) ? input : (input.installIds ?? [])
      const uninstallIds = Array.isArray(input) ? [] : (input.uninstallIds ?? [])
      if (this.preinstall.installing || (installIds.length === 0 && uninstallIds.length === 0))
        return
      this.preinstall.installing = true
      this.preinstall.error = ''
      this.preinstall.logs = []
      let unlisten: UnlistenFn | null = null
      try {
        unlisten = await this.listenPreinstallLog()
        await invoke('install_preinstall_plugins', { installIds, uninstallIds })
        // 后端装完已把服务停掉，这里在日志面板讲清接下来的重启（issue #48），
        // 避免用户把"插件安装后的自动重启"误认为崩溃/故障。
        this.preinstall.logs = [...this.preinstall.logs, i18next.t('preinstall.restarting_hint')].slice(-200)
        await this.continueAfterPreinstall()
      }
      catch (err) {
        console.error('[Harness] preinstall failed:', err)
        const error = String(err)
        this.preinstall.error = error.startsWith('NETWORK_ERROR:')
          ? i18next.t('preinstall.network_error')
          : error
      }
      finally {
        unlisten?.()
        this.preinstall.installing = false
        this.preinstall.cancelling = false
      }
    },

    /**
     * 取消正在进行的预装插件安装：网络抖动/拉包限流（429）时可能长时间卡在
     * pnpm 重试；调用后端强杀插件安装进程树，回到可重试的选择态。
     */
    async cancelPreinstall() {
      if (!this.preinstall.installing || this.preinstall.cancelling)
        return
      // 后端结束进程树导致 `install_preinstall_plugins` 提前返回并进入 catch，
      // 通过 installing=false 让其回到列表态而不是报错态。
      this.preinstall.cancelling = true
      // 一次性监听：先挂事件（拿到注销函数再 invoke），finally 里注销，
      // 避免每次取消都永久注册一个 `preinstall-cancelled` 监听（泄漏）。
      let unlisten: (() => void) | undefined
      try {
        unlisten = await listen<unknown>('preinstall-cancelled', () => {
          this.preinstall.installing = false
          this.preinstall.cancelling = false
        })
        await invoke('cancel_preinstall_plugins')
      }
      catch (err) {
        console.error('[Harness] cancel preinstall failed:', err)
        this.preinstall.cancelling = false
      }
      finally {
        unlisten?.()
      }
    },

    /** 跳过预装插件引导：记录状态后继续启动服务 */
    async skipPreinstall() {
      if (this.preinstall.installing)
        return
      try {
        await invoke('skip_preinstall_plugins')
        await this.continueAfterPreinstall()
      }
      catch (err) {
        console.error('[Harness] skip preinstall failed:', err)
        this.preinstall.error = String(err)
      }
    },

    /** 预装引导结束后的收尾：拉起服务等待就绪，并静默检查更新 */
    async continueAfterPreinstall() {
      await this.launchAndWait()
      void harnessUpdater.checkForUpdate()
    },

    /**
     * 从侧边栏重新打开预装插件引导：可重新选择/安装推荐插件。
     * 关闭引导（确定/跳过）后回到正常启动流程，服务若在运行则保持原状态。
     */
    async openPreinstall() {
      if (this.preinstall.installing)
        return
      emitter.emit('config:dialog:hidden')
      this.preinstall.error = ''
      this.preinstall.logs = []
      // 侧边栏手动打开：非首次安装，默认勾选策略为「仅已安装」
      this.preinstall.isFirstTime = false
      this.status = 'preinstall'
      await this.loadPreinstallPlugins()
    },
  },
})

// 进入 ready 后 iframe 长时间未加载（dsh 未就绪/挂起）→ 转为错误界面，
// 避免一直停在黑色加载遮罩
let iframeLoadTimer: ReturnType<typeof setTimeout> | null = null
harness.$subscribe(() => {
  const { status, serviceHealthy, iframeLoaded, iframeError } = harness.$state
  if (status === 'ready' && serviceHealthy && !iframeLoaded && !iframeError) {
    if (!iframeLoadTimer) {
      iframeLoadTimer = setTimeout(() => {
        iframeLoadTimer = null
        harness.iframeLoaded = false
        harness.iframeError = true
      }, IFRAME_LOAD_TIMEOUT)
    }
  }
  else {
    if (iframeLoadTimer) {
      clearTimeout(iframeLoadTimer)
      iframeLoadTimer = null
    }
  }
})
