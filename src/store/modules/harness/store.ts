import type { UnlistenFn } from '@tauri-apps/api/event'
import type {
  InstallerState,
  InstallProgress,
  PluginCommandLogPayload,
  PreinstallPlugin,
  SetupStatus,
  SidebarBusyAction,
} from './types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { updater } from '../updater'

const MAX_RETRIES = 8
const IFRAME_LOAD_TIMEOUT = 20000
/** 启动失败时从服务日志尾部挑选的原始行上限（ANSI 清洗后按行截断） */
const LOG_TAIL_MAX_BYTES = 16 * 1024
/** 日志中常见的错误标记，用于失败时挑出真正的问题行而不是整个堆栈 */
const ERROR_LINE_MARKERS = /error|duplicate|fatal|panic|throw|✖|exception|failed/i
const PLUGIN_CONFLICT_MARKERS = [
  'duplicate prefix route',
  'duplicate exact route',
  'duplicate upgrade route',
  'multiple fallback owners',
] as const
const STARTUP_DIAGNOSTIC_RETRIES = 6
const STARTUP_DIAGNOSTIC_RETRY_DELAY = 150

function hasPluginConflict(lines: readonly string[]): boolean {
  const text = lines.join('\n').toLowerCase()
  return PLUGIN_CONFLICT_MARKERS.some(marker => text.includes(marker))
}

/** 启动失败错误：附带从 dsh 服务日志中读取的真实错误行 */
interface StartupError extends Error {
  logs?: string[]
}

const initialInstaller: InstallerState = {
  title: '',
  detail: '',
  percentage: 0,
  logs: [],
}

/** 启动流程令牌：boot 并发/重复调用时只采纳最后一次的结果 */
let bootToken = 0
/** 首次自动启动去重（React StrictMode 会重复挂载 effect） */
let bootStarted = false

/** 构建带时间戳的 iframe URL，避免 WebView2 缓存旧页面 */
function generateTimestampedUrl(baseUrl: string): string {
  const timestamp = Date.now()
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}t=${timestamp}`
}

/** 健康检查结果：healthy 表示服务就绪；notOwned 表示 dsh 进程已退出（启动即崩溃，快速失败信号） */
interface HealthCheckResult {
  healthy: boolean
  notOwned: boolean
}

/** 通过 Rust 代理探测服务健康状态（超时 8s，网络抖动时重试） */
async function checkHealthViaProxy(): Promise<HealthCheckResult> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('health check timeout')), 8000)
    })
    const resultPromise = invoke<string>('proxy_health_check')
    const result = await Promise.race([resultPromise, timeoutPromise])

    const lower = result.toLowerCase()
    if (
      lower.includes('healthy')
      || lower.includes('ready')
      || result.includes('200')
      || result.includes('201')
      || lower.includes('ok')
    ) {
      console.warn('[Harness] health check passed:', result)
      return { healthy: true, notOwned: false }
    }
    console.warn('[Harness] health check returned:', result)
    return { healthy: false, notOwned: false }
  }
  catch (err) {
    const message = String(err)
    if (message.includes('HARNESS_NOT_OWNED')) {
      // dsh 进程已退出（典型如插件冲突导致启动即崩溃），继续等只会白白耗完
      // 8 轮超时，让调用方立刻结束重试并展示日志里的真实错误。
      console.warn('[Harness] dsh process exited during startup, failing fast')
      return { healthy: false, notOwned: true }
    }
    if (message.includes('502') || message.includes('Bad Gateway')) {
      console.warn('[Harness] transient 502 during health check, retrying')
    }
    else {
      console.error('[Harness] health check failed:', err)
    }
    return { healthy: false, notOwned: false }
  }
}

/** 读取服务日志尾部（去掉 ANSI 转义与空行），启动失败时展示真实错误 */
async function readServiceLogTail(): Promise<string[]> {
  try {
    const raw = await invoke<string>('read_service_logs', { maxBytes: LOG_TAIL_MAX_BYTES })
    return raw
      .split(/\r?\n/)
      .map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
      .filter(Boolean)
  }
  catch (err) {
    console.error('[Harness] failed to read service logs:', err)
    return []
  }
}

/** 从日志行中挑出真正的错误行（命中错误标记，最多 8 行）；没有命中则退回最后 8 行 */
function pickErrorLines(lines: string[]): string[] {
  const errored = lines.filter(line => ERROR_LINE_MARKERS.test(line)).slice(0, 8)
  return errored.length > 0 ? errored : lines.slice(-8)
}

/** 失败时把服务日志的真实错误行挂到错误对象上；已识别的路由冲突可提前停止重读。 */
async function attachStartupDiagnostics(err: unknown): Promise<StartupError> {
  const startupError = err as StartupError
  let lines = startupError.logs ?? []
  let hasKnownPluginConflict = false

  // 子进程输出由独立线程逐行写入日志；进程退出与最后一行落盘之间存在竞态。
  // 失败后短暂重读，避免错误页只拿到启动 URL 而漏掉真正的错误。
  for (let attempt = 0; attempt <= STARTUP_DIAGNOSTIC_RETRIES; attempt++) {
    const latestLines = await readServiceLogTail()
    if (latestLines.length > 0)
      lines = latestLines
    hasKnownPluginConflict = hasKnownPluginConflict || hasPluginConflict(lines)
    if (hasKnownPluginConflict || attempt === STARTUP_DIAGNOSTIC_RETRIES)
      break
    await new Promise(resolve => setTimeout(resolve, STARTUP_DIAGNOSTIC_RETRY_DELAY))
  }

  startupError.logs = pickErrorLines(lines)
  return startupError
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
    /** 预装插件引导状态：列表/安装进度/日志/错误 */
    preinstall: {
      plugins: [] as PreinstallPlugin[],
      loading: false,
      installing: false,
      /** 用户触发了“取消”但仍需等后端结束进程树 */
      cancelling: false,
      logs: [] as string[],
      error: '',
    },
    serviceUrl: 'http://127.0.0.1:3080',
    /** 带时间戳的 iframe 地址（boot 时生成一次，避免缓存） */
    iframeSrc: '',
    iframeLoaded: false,
    iframeError: false,
    iframeKey: 0,
    serviceHealthy: false,
    serviceRunning: false,
    busyAction: null as SidebarBusyAction,
  }),
  actions: {
    /** 首次挂载时自动启动（StrictMode 重复挂载下保证只执行一次） */
    startup() {
      if (bootStarted)
        return
      bootStarted = true
      void this.boot()
    },

    /** 刷新 iframe：清除加载态并延迟重新挂载 */
    refreshIframe() {
      this.iframeLoaded = false
      this.iframeError = false
      setTimeout(() => {
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

    /** 拉起服务并等待健康检查通过，通过后才允许挂载 iframe */
    async launchAndWait() {
      this.status = 'ready'
      this.installer = initialInstaller
      this.errorLogs = []
      this.serviceHealthy = false
      this.iframeLoaded = false
      this.iframeError = false
      try {
        await invoke('launch_harness')
        this.serviceRunning = true
        // 后端遇到端口占用时会自动递增并持久化端口，启动后重新读取真实地址。
        const runtimeInfo = await invoke<{ service_url: string }>('get_runtime_info')
        this.serviceUrl = runtimeInfo.service_url
        this.iframeSrc = generateTimestampedUrl(runtimeInfo.service_url)

        let healthy = false
        let notOwned = false
        for (let attempt = 0; attempt < MAX_RETRIES && !healthy && !notOwned; attempt++) {
          const result = await checkHealthViaProxy()
          healthy = result.healthy
          notOwned = result.notOwned
          if (!healthy && !notOwned) {
            await new Promise(resolve => setTimeout(resolve, 2000))
          }
        }
        if (!healthy) {
          throw new Error(
            i18next.t('errors.service_start_timeout', { port: new URL(this.serviceUrl).port || '3080' }),
          )
        }
        this.serviceHealthy = true
      }
      catch (err) {
        // 失败时附上服务日志里的真实错误行，供错误界面展示而不是只显示超时文案
        throw await attachStartupDiagnostics(err)
      }
    },

    /** 启动流程：检测环境/安装依赖 → 拉起服务 → 已安装时后台检查更新 */
    async boot() {
      const token = ++bootToken
      // 回到加载态：已安装时不再显示检测/启动界面，直接进入页面加载状态
      this.serviceHealthy = false
      this.iframeLoaded = false
      this.iframeError = false
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

        // 仅首次使用需要检测环境/安装依赖；之后直接进入页面。
        // 桌面端自更新（MSI 强杀进程）后 store 可能被复位/损坏显示未安装，
        // 但运行时文件已全部在盘——此时跳过安装/下载界面，install_dependencies
        // 内部自愈补记 installed 后直接启动，避免自动重开时闪现误导用户的界面。
        if (!config.installed) {
          const ready = await invoke<boolean>('runtime_ready')
          if (!ready) {
            this.status = 'installing'
            this.installer = { ...initialInstaller, title: i18next.t('status.installing') }
          }
          await invoke('install_dependencies')
        }

        // 预装插件引导：首次安装、老版本升级（无指纹基线）或 preset-plugins.json
        // 内容变更（社区新增推荐插件）时重新进入预设流程，装完/跳过后才拉起服务。
        // preset-plugins.json 随安装包发布、每次安装被强制覆盖，旧文件不可比对，
        // 由 Rust 侧记录内容指纹到 app-data（.store.dat），启动时比对是否有变更。
        if (await invoke<boolean>('get_preinstall_pending')) {
          this.status = 'preinstall'
          await this.loadPreinstallPlugins()
          return
        }

        await this.launchAndWait()

        if (token !== bootToken)
          return
        // 已安装时后台静默检查新版，发现后提示用户
        if (config.installed) {
          void updater.checkForUpdate()
        }
      }
      catch (err) {
        if (token !== bootToken)
          return
        console.error('[Harness] startup failed:', err)
        const startupError = await attachStartupDiagnostics(err)
        this.fail(String(startupError), startupError.logs)
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
    fail(message: string, logs?: string[]) {
      this.errorMsg = message
      this.errorLogs = logs ?? []
      this.status = 'error'
      this.serviceRunning = false
    },

    /** 重启服务：先强杀再拉起，最终回到就绪/错误态 */
    async restart() {
      if (this.busyAction)
        return
      this.busyAction = 'restart'
      try {
        await invoke('shutdown_harness')
      }
      catch (err) {
        console.error('[Harness] shutdown during restart failed:', err)
      }
      this.serviceRunning = false
      this.iframeLoaded = false
      try {
        await this.boot()
      }
      finally {
        this.busyAction = null
      }
    },

    /** 停止服务并回到停止态界面 */
    async shutdown() {
      if (this.busyAction)
        return
      this.busyAction = 'shutdown'
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
    /** 移除用户选定的冲突插件，完成后等待用户手动重启服务 */
    async recoverPluginConflict(id: string): Promise<boolean> {
      if (this.busyAction)
        return false
      this.busyAction = 'pluginRecovery'
      try {
        await invoke('remove_dsh_plugin', { id })
        this.serviceRunning = false
        this.serviceHealthy = false
        this.iframeLoaded = false
        return true
      }
      catch (err) {
        console.error('[Harness] plugin conflict recovery failed:', err)
        this.errorMsg = String(err)
        this.status = 'error'
        this.serviceRunning = false
        this.serviceHealthy = false
        return false
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
      }
      catch (err) {
        console.error('[Harness] failed to load preinstall plugins:', err)
      }
      finally {
        this.preinstall.loading = false
      }
      return this.preinstall.plugins
    },

    /** 插件命令日志流：dsh plugin 进程与桌面端编排输出逐行追加 */
    async listenPluginCommandLog(): Promise<UnlistenFn> {
      return listen<PluginCommandLogPayload>('dsh-plugin-command-log', (e) => {
        this.preinstall.logs = [...this.preinstall.logs, e.payload.line].slice(-200)
      })
    },

    /** 确认安装选中的预装插件：流式日志，完成后继续启动服务 */
    async confirmPreinstall(ids: string[]) {
      if (this.preinstall.installing || ids.length === 0)
        return
      this.preinstall.installing = true
      this.preinstall.error = ''
      this.preinstall.logs = []
      let unlisten: UnlistenFn | null = null
      try {
        unlisten = await this.listenPluginCommandLog()
        await invoke('install_preinstall_plugins', { ids })
        await this.continueAfterPreinstall()
      }
      catch (err) {
        console.error('[Harness] preinstall failed:', err)
        this.preinstall.error = String(err)
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
      try {
        await invoke('cancel_preinstall_plugins')
        await listen<unknown>('preinstall-cancelled', () => {
          this.preinstall.installing = false
          this.preinstall.cancelling = false
        })
      }
      catch (err) {
        console.error('[Harness] cancel preinstall failed:', err)
        this.preinstall.cancelling = false
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
      void updater.checkForUpdate()
    },

    /**
     * 从侧边栏重新打开预装插件引导：可重新选择/安装推荐插件。
     * 关闭引导（确定/跳过）后回到正常启动流程，服务若在运行则保持原状态。
     */
    async openPreinstall() {
      if (this.preinstall.installing)
        return
      this.preinstall.error = ''
      this.preinstall.logs = []
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
