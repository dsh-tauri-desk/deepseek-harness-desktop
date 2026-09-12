import type { DshPlugin, DshThemePreference, ResolvedTheme } from '@/types'
import { useEventListener, useIntervalFn, useMount, usePreferredDark, useWakeLock, useWatch } from '@reause/core'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { queryKeys } from '@/config/query-keys'
import { useListen } from '@/hooks/use-listen'
import { useCoreBreakingConfirm } from '@/ui/config/hooks/use-core-breaking-confirm'
import { toast } from '@/utils/toast'
import { store } from '../store'
import { Recovery } from '../ui/plugin/recovery'
import { Webview } from './components/webview'
import '../i18n'

/** 桌面端自更新轮询间隔：Rust 侧不缓存，改为低频轮询以免触发 GitHub 未认证限流（60 次/小时/IP） */
const DESKTOP_UPDATE_POLL_INTERVAL = 10 * 60_000

/** Rust 侧 on_download 接管下载后 emit 的完成事件载荷（与 desktop::payload 对齐） */
interface DownloadFinishedPayload {
  url: string
  path: string | null
  success: boolean
}

/**
 * 应用根布局：只负责首次启动、壳层结构与若干后台副作用。
 *
 * 业务状态与操作方法全部收敛到 valtio-define store，各子组件自行订阅 store，
 * 不再通过 props 透传回调与状态；弹出层（关于 / 检查更新 / 应用配置 / 插件异常修复）
 * 统一由 overlastic 命令式打开，仅在需要时挂载。
 *
 * 原先独立的后台组件已内置到本组件（都只产出副作用或一个 holder，
 * 或需要「无论哪个面板挂载都在跑」的全局性，不值得各占一个文件）：
 * - 桌面端更新轮询（低频 `useIntervalFn`，失败静默）；
 * - 下载完成提示（订阅 `harness-download-finished`，事件到手即弹 toast）；
 * - 核心更新提示（`useWatch` 观察更新状态，返回 `useCoreBreakingConfirm` 的 holder）；
 * - 外壳主题同步（订阅 `dsh-theme-updated` + 系统明暗，写 `<html data-theme>`）；
 * - 插件列表缓存同步（订阅 `dsh-plugins-updated`，写入 react-query 缓存，
 *   供插件面板 / 配置对话框角标 / 导航栏共用）。
 */
export function App() {
  // —— 外壳主题 ——
  // dsh 把主题偏好持久化在 `$DSH_HOME/settings.yaml` 的 `ui-theme.preference`
  // （light/dark/system），后端轮询到变化后经 `dsh-theme-updated` 推送；这里解析为
  // 最终主题写到 `<html data-theme="...">`，由 CSS 变量切换配色。
  // - 系统明暗由 reause `usePreferredDark` 实时订阅媒体查询；
  // - 首次偏好 `useMount` 拉取，后续变化 `useListen` 订阅；
  // - 主题落盘 `<html data-theme>` 用 `useWatch` 观察最终主题。
  const [themePreference, setThemePreference] = useState<DshThemePreference>('dark')
  const systemDark = usePreferredDark()
  const theme: ResolvedTheme = themePreference === 'system' ? (systemDark ? 'dark' : 'light') : themePreference

  useMount(() => {
    invoke<DshThemePreference>('get_dsh_theme')
      .then(setThemePreference)
      .catch(err => console.error('[App] failed to load theme:', err))
  })

  useListen<DshThemePreference>('dsh-theme-updated', event => setThemePreference(event.payload))

  useWatch(theme, (value) => {
    document.documentElement.dataset.theme = value
  }, { immediate: true })

  // —— 插件列表缓存同步 ——
  // 后端（`service/plugin/watch`）解析出完整插件列表后经 `dsh-plugins-updated` 推送，
  // 这里直接写入查询缓存（事件载荷即完整列表，无需额外往返拉取）。缓存由所有消费者
  // 共用：插件面板（查询 + 操作）、配置对话框的异常角标、导航栏的 dsh-tauri 检测。
  const queryClient = useQueryClient()
  useListen<DshPlugin[]>('dsh-plugins-updated', ({ payload }) => {
    queryClient.setQueryData(queryKeys.plugins, payload)
  })

  const { t } = useTranslation()
  const { status } = useStore(store.harness)
  const { updateInfo, updating } = useStore(store.harnessUpdater)
  const { holder: coreBreakingHolder, confirmCoreBreaking } = useCoreBreakingConfirm()

  // issue #469：本应用没有屏幕常亮的正当需求（常驻播放的 <video> 会让系统无法息屏），
  // 唤醒锁一旦生效就立刻释放。
  const wakelock = useWakeLock()
  useWatch(wakelock.isActive, () => {
    void wakelock.release()
  }, { immediate: true })

  // 仅开发模式：快捷键预览「插件异常修复界面」，便于快速看到实际 UI（不影响生产构建）。
  //   Ctrl+Shift+1 → 运行期异常对话框（应用仍在运行）
  //   Ctrl+Shift+2 → 启动崩溃全屏恢复页
  // 生产构建下监听仍在（reause `useEventListener` 无法条件订阅），但首个分支即返回。
  useEventListener('keydown', (event: KeyboardEvent) => {
    if (!import.meta.env.DEV)
      return
    if (!event.ctrlKey || !event.shiftKey)
      return
    if (event.code === 'Digit1') {
      event.preventDefault()
      store.recovery.setRuntimeRecovery({
        plugins: ['dsh-better-sidebar'],
        reason: 'slot_conflict',
        detail: 'sidebar',
        raw_error: 'Preview: dsh-better-sidebar reported a UI slot conflict.',
      })
    }
    else if (event.code === 'Digit2') {
      event.preventDefault()
      store.harness.fail('Preview: plugin startup failure')
      store.recovery.setRuntimeRecovery({
        plugins: ['dsh-better-sidebar'],
        reason: 'duplicate_loader_entry',
        detail: 'dshSidebarApi',
        raw_error: 'Preview: duplicate loader entry id: dshSidebarApi',
      })
    }
  })

  // 首次挂载自动启动 harness（store 内部对 StrictMode 重复挂载去重）
  useMount(() => store.harness.startup())

  // 桌面端更新轮询：启动即检查一次，之后低频轮询；失败一律静默（不打扰用户）。
  // 发现新版本由 store 静默下载安装包，更新入口收敛到导航栏 chip 与「帮助 > 检查更新」。
  function checkDesktopUpdate() {
    void store.desktopUpdater.check().catch(() => {})
  }
  useMount(checkDesktopUpdate)
  useIntervalFn(checkDesktopUpdate, DESKTOP_UPDATE_POLL_INTERVAL)

  // 下载完成提示：dsh iframe 内的下载在 WebView2 中是静默保存的（用户零感知），
  // 由外壳订阅 Rust 侧完成事件，弹出「已保存 + 打开文件夹」提示。
  const toastKeyRef = useRef<string | null>(null)
  useListen<DownloadFinishedPayload>('harness-download-finished', ({ payload }) => {
    if (status !== 'ready')
      return
    if (toastKeyRef.current)
      toast.close(toastKeyRef.current)
    const { success, path } = payload
    toastKeyRef.current = toast(success ? t('download.saved') : t('download.failed'), {
      description: success && path
        ? (
            <div className="truncate max-w-[300px]">
              {`${t('download.saved_to')}: ${path}`}
            </div>
          )
        : undefined,
      placement: 'bottom end',
      actionProps: success && path
        ? {
            children: t('download.show_in_folder'),
            variant: 'tertiary',
            onPress: () => {
              if (toastKeyRef.current)
                toast.close(toastKeyRef.current)
              void invoke('reveal_in_folder', { path }).catch((err) => {
                console.error('[Harness] reveal_in_folder failed:', err)
              })
            },
          }
        : undefined,
      onClose: () => {
        toastKeyRef.current = null
      },
    })
  })

  // 新版本提示：仅提示不打断用户；破坏性更改确认推迟到点击「立即更新」时
  useWatch([updateInfo, updating], () => {
    if (!updateInfo || updating)
      return
    store.harnessUpdater.showToast(() => handleUpdate())
  }, { immediate: true })

  /** 点击「立即更新」：目标版本高于 rc.2 时先弹破坏性更改确认，取消则中止更新 */
  async function handleUpdate() {
    const info = store.harnessUpdater.updateInfo
    if (!info || !(await confirmCoreBreaking(info.tag)))
      return
    await store.harnessUpdater.handleUpdate()
  }

  return (
    <div className="flex h-screen w-screen">
      <Webview />
      <If cond={status === 'ready'}>
        {coreBreakingHolder}
      </If>
      {/* 运行期插件异常：应用仍在运行，弹醒目对话框（启动崩溃走 webview 的全屏恢复页） */}
      <If cond={status === 'ready'}>
        <Recovery />
      </If>
    </div>
  )
}
