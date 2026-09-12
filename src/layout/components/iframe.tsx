/* eslint-disable react/dom-no-unsafe-iframe-sandbox */
import type { RefObject } from 'react'
import type { ZoomAction } from '@/utils/zoom'
import { CircleExclamation } from '@gravity-ui/icons'
import { useEventListener, useIntervalFn } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { queryClient } from '@/config/client'
import { queryKeys } from '@/config/query-keys'
import { useIframeMessage } from '@/hooks/use-iframe-message'
import { useIframePost } from '@/hooks/use-iframe-post'
import { useInvokeIframe } from '@/hooks/use-invoke-iframe'
import { useListen } from '@/hooks/use-listen'
import { useZoomFactor } from '@/hooks/use-zoom-factor'
import { store } from '@/store'
import { nextZoomFactor, zoomActionFromBridgeMessage, zoomActionFromShortcut } from '@/utils/zoom'
import { Loadable } from './loadable'

/** 可见性兜底轮询间隔：主路径是窗口 focus/resize 事件，5s 足以覆盖任务栏切换等场景 */
const VISIBILITY_POLL_INTERVAL = 5000

/**
 * iframe → 宿主 的桥消息（宿主侧按 `type` 分发，不比对 `source`）。
 * 只列 iframe 自身关心的桥：通知 / 插件异常 / 剪贴板图片 / 插件 boot
 * （导航桥的 `dsh://sidebar:collapsed` 由 `webview.tsx` 处理）。
 */
interface IframeBridgeMessage {
  type?: string
  /** 通知桥 */
  title?: string
  body?: string
  tag?: string
  sessionId?: string | null
  requireInteraction?: boolean
  /** 插件异常桥 / 剪贴板图片桥：插件 id 或剪贴板请求 id */
  id?: string
  error?: string
  action?: string
  /** 插件 boot 桥：失败页文本 */
  detail?: string
}

export interface IframeProps {
  /** iframe 元素 ref（由 `webview.tsx` 创建：导航桥也要用同一个 ref 收发） */
  iframeRef: RefObject<HTMLIFrameElement | null>
}

/**
 * 主区域 iframe：元素、加载/失败覆盖层，以及 iframe 自身的一整套桥。
 *
 * - 出站：`useIframePost`（origin 定向 + `source: 'dsh-desktop'` 协议标识）；
 * - 入站：`useIframeMessage`（直接 iframe + origin 校验）+ 一个 `switch (type)`
 *   （原生通知 / 插件异常上报 / 剪贴板图片回退 / 插件 boot 状态 / 缩放快捷键）；
 * - 缩放：真值放在 `store.setting.zoom_factor`（persist 插件写入的 `setting` 键与
 *   Rust 共用同一份 `.store.dat`，重启后由 Rust 在窗口创建时按同一规则应用），
 *   壳层快捷键与 iframe 缩放桥只更新该真值，把它落到 WebView 由 `useZoomFactor`
 *   负责（挂载一次 + 值变化时重应用）；若平台没有原生缩放能力则跳过应用；
 * - 附加桥：Tauri invoke 转发 `useInvokeIframe`；
 * - 系统通知点击回传、窗口可见性同步（focus/resize + 兜底轮询）。
 *
 * 侧边栏导航桥（`dsh://sidebar:collapsed` / `dsh://sidebar:toggle`）不在这里——
 * 它属于壳层导航栏的状态，由 `webview.tsx` 用同一份 post/message 处理。
 *
 * 加载失败时**保持 iframe 挂载**，用覆盖层提供重试，重试复用同一 iframe 实例。
 */
export function Iframe({ iframeRef }: IframeProps) {
  const { t } = useTranslation()
  const {
    serviceHealthy,
    startupStatusKey,
    showIframeError,
    iframeKey,
    iframeSrc,
    serviceUrl,
  } = useStore(store.harness)
  const { zoom_factor: zoomFactor } = useStore(store.setting)

  const post = useIframePost(iframeRef)
  useInvokeIframe(iframeRef)

  // 缩放真值 → WebView：显式传入真值，挂载时应用一次、之后真值变化才重应用；
  // 平台能力判定（macOS 10.15 没有原生缩放）由 `useZoomFactor` 内部处理
  useZoomFactor(zoomFactor)

  /** 缩放动作只改真值（store 负责落盘），应用交给上面的 `useZoomFactor` */
  function applyZoom(action: ZoomAction) {
    store.setting.zoom_factor = nextZoomFactor(zoomFactor, action)
  }

  /** 壳层快捷键（焦点在导航栏等壳层元素时；iframe 内由注入脚本经缩放桥转发） */
  function handleZoomKeyDown(event: KeyboardEvent) {
    const action = zoomActionFromShortcut(event)
    if (!action)
      return
    event.preventDefault()
    applyZoom(action)
  }

  useEventListener('keydown', handleZoomKeyDown, { capture: true })

  // iframe → 宿主：iframe 自身的桥共用一个监听器，按 `data.type` 分发
  useIframeMessage<IframeBridgeMessage>(iframeRef, (data, { origin }) => {
    switch (data.type) {
      // 原生通知：转发给 Tauri 命令弹出系统通知
      case 'dsh://native-notification':
        void invoke('show_native_notification', {
          payload: {
            title: data.title ?? '',
            body: data.body ?? '',
            tag: data.tag ?? null,
            sessionId: data.sessionId ?? null,
            requireInteraction: Boolean(data.requireInteraction),
          },
        }).catch(error => console.error('[notification] show_native_notification failed:', error))
        break

      // 插件异常上报：写后端错误注册表，并刷新插件列表（「插件」面板据此展示 danger 与修复入口）
      case 'dsh://plugin-error':
        if (!data.id || !data.error)
          break
        void invoke('report_plugin_error', {
          id: data.id,
          error: data.error,
          action: data.action ?? 'runtime',
        })
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.plugins })
          })
          .catch(error => console.error('[plugin-error] report_plugin_error failed:', error))
        break

      // 剪贴板图片回退：读系统剪贴板并把 PNG data URL 回传
      // （Linux/WebKitGTK 下 dsh iframe 的 paste 事件拿不到图片，走原生剪贴板通路）
      case 'dsh://clipboard-image:read': {
        if (!data.id)
          break
        const reqId = data.id
        function reply(dataUrl: string | null) {
          iframeRef.current?.contentWindow?.postMessage(
            { source: 'dsh-desktop-clipboard', id: reqId, data_url: dataUrl },
            origin,
          )
        }
        void invoke<{ data_url?: string } | null>('read_clipboard_image')
          .then(result => reply(result?.data_url ?? null))
          .catch((error) => {
            console.error('[clipboard-image] read_clipboard_image failed:', error)
            reply(null)
          })
        break
      }

      // 插件 boot 状态：failed 携带官方失败页文本（如 web boot: 1 entry did not activate）
      case 'dsh://plugin-boot:ready':
        store.harness.markIframeBootReady()
        break
      case 'dsh://plugin-boot:stalled':
        void store.harness.recoverIframeBoot()
        break
      case 'dsh://plugin-boot:failed':
        void store.harness.handleIframeBootFailure(data.detail)
        break

      // 缩放快捷键：跨源 iframe 内的 Ctrl/Cmd +/-/0 不会冒泡到壳层，由 dsh-tauri 插件的
      // `client/register/zoom-shortcut.ts` 在 iframe 内捕获后经父窗口桥转发到这里
      case 'dsh://zoom-shortcut': {
        const action = zoomActionFromBridgeMessage(data)
        if (action)
          applyZoom(action)
        break
      }
    }
  })

  // 系统通知点击 → 让 iframe 聚焦对应会话
  useListen<{ sessionId?: string | null, title?: string, tag?: string }>(
    'dsh-notification-clicked',
    (event) => {
      const payload = event.payload
      post({
        type: 'dsh://focus-session',
        sessionId: payload.sessionId || undefined,
        title: payload.title || undefined,
        tag: payload.tag || undefined,
      })
    },
  )

  // 将窗口可见性（最小化/隐藏/失焦）同步给 iframe，便于其暂停渲染
  function syncVisibility() {
    void (async () => {
      try {
        const appWindow = getCurrentWindow()
        const [minimized, visible] = await Promise.all([
          appWindow.isMinimized(),
          appWindow.isVisible(),
        ])
        post({ type: 'dsh://visibility-state', hidden: minimized || !visible })
      }
      catch (error) {
        console.error('[notification] sync visibility failed:', error)
      }
    })()
  }

  // 窗口焦点/尺寸变化时即时同步可见性（Tauri 窗口事件非 `listen`，保留 effect 承担注销）
  useEffect(() => {
    let disposed = false
    let unlisteners: Array<() => void> = []
    void (async () => {
      try {
        const appWindow = getCurrentWindow()
        syncVisibility()
        const unFocus = await appWindow.onFocusChanged(() => {
          void syncVisibility()
        })
        const unResized = await appWindow.onResized(() => {
          void syncVisibility()
        })
        // 订阅完成前若已卸载则立即释放，避免回调泄漏
        if (disposed) {
          unFocus()
          unResized()
        }
        else {
          unlisteners = [unFocus, unResized]
        }
      }
      catch (error) {
        console.error('[notification] visibility listeners failed:', error)
      }
    })()
    return () => {
      disposed = true
      unlisteners.forEach(fn => fn())
    }
  }, [])

  // 兜底轮询：覆盖监听不到的状态变化（如任务栏切换）；主路径是窗口焦点/尺寸事件
  useIntervalFn(syncVisibility, VISIBILITY_POLL_INTERVAL)

  return (
    <div className="relative min-h-0 flex-1">
      <If
        cond={serviceHealthy}
        else={<Loadable subtitle={t(startupStatusKey)} />}
      >
        <iframe
          key={iframeKey}
          ref={iframeRef}
          className="block h-full w-full border-none bg-load-bg"
          src={iframeSrc}
          allow="accelerometer; ambient-light-sensor; autoplay; battery; camera; clipboard-read; clipboard-write; display-capture; document-domain; encrypted-media; fullscreen; gamepad; geolocation; gyroscope; hid; idle-detection; keyboard-map; magnetometer; microphone; midi; payment; picture-in-picture; publickey-credentials-get; screen-wake-lock; serial; speaker-selection; usb; web-share; xr-spatial-tracking"
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-downloads allow-storage-access-by-user-activation"
          onLoad={store.harness.markIframeLoaded}
          onError={store.harness.markIframeError}
          title={t('app.open_editor')}
        />
      </If>

      <If cond={showIframeError}>
        <div className="absolute inset-0 z-[1]">
          <Loadable
            icon={CircleExclamation}
            title={t('ui.iframe_error')}
            errorMsg={t('ui.ensure_running', { url: serviceUrl })}
            onRetry={store.harness.refreshIframe}
          />
        </div>
      </If>
    </div>
  )
}
