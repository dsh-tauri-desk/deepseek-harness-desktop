import type { RefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect } from 'react'
import { useEvent, useInterval, useMountedState } from 'react-use'
import { queryClient } from '@/config/client'
import { store } from '@/store'
import { getIframeOrigin } from '@/utils/iframe'

interface NativeNotificationMessage {
  source?: 'dsh-notification-bridge'
  type?: string
  title?: string
  body?: string
  tag?: string
  sessionId?: string
  requireInteraction?: boolean
}

/** iframe 插件异常上报消息（dsh-tauri 桥 / 页面脚本 postMessage 通道） */
interface PluginErrorMessage {
  source?: 'dsh-plugin-error-bridge'
  type?: string
  /** 插件 id（npm 包名） */
  id?: string
  /** 异常消息 */
  error?: string
  /** 记录动作：runtime / install / update（默认 runtime） */
  action?: string
}

const PLUGIN_ID_PATTERN = /^(?:@[\w.-]+\/)?\w[\w.-]{0,127}$/
const PLUGIN_ERROR_ACTIONS = new Set(['install', 'update', 'remove', 'runtime'])
const MAX_PLUGIN_ERROR_CHARS = 2000
const NOTIFICATION_TEST_TAG_PATTERN = /^dsh-notification-test-\d{1,20}$/
const NOTIFICATION_SESSION_TAG_PATTERN = /^dsh-notification-(?:pending-)?\w[\w.-]{0,127}-\d{1,20}$/
const NOTIFICATION_SESSION_PATTERN = /^\w[\w.-]{0,127}$/
const MAX_NOTIFICATION_TITLE_CHARS = 256
const MAX_NOTIFICATION_BODY_CHARS = 4096

function startsWithAsciiAlphaNumeric(value: string): boolean {
  const code = value.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isValidPluginId(value: string): boolean {
  const packageName = value.startsWith('@') ? value.slice(value.indexOf('/') + 1) : value
  return PLUGIN_ID_PATTERN.test(value) && startsWithAsciiAlphaNumeric(packageName)
}

function isValidNotificationSession(value: string): boolean {
  return NOTIFICATION_SESSION_PATTERN.test(value) && startsWithAsciiAlphaNumeric(value)
}

function isValidNotificationTag(value: string): boolean {
  if (NOTIFICATION_TEST_TAG_PATTERN.test(value)) {
    return true
  }
  if (!NOTIFICATION_SESSION_TAG_PATTERN.test(value)) {
    return false
  }
  const rest = value.slice('dsh-notification-'.length)
  const sessionAndSequence = rest.startsWith('pending-') ? rest.slice('pending-'.length) : rest
  const sequenceSeparator = sessionAndSequence.lastIndexOf('-')
  return isValidNotificationSession(sessionAndSequence.slice(0, sequenceSeparator))
}

interface PluginBootMessage {
  source?: 'dsh-plugin-boot-bridge'
  type?: 'dsh://plugin-boot:stalled' | 'dsh://plugin-boot:ready'
}

export function useIframeShim(iframeRef: RefObject<HTMLIFrameElement | null>) {
  const isMounted = useMountedState()

  // 接收 iframe 的「原生通知」请求，转发给 Tauri 命令弹出系统通知
  function handleMessage(event: MessageEvent<NativeNotificationMessage>) {
    const data = event.data
    if (!data || typeof data !== 'object' || data.source !== 'dsh-notification-bridge') {
      return
    }
    // 只接受 DSH 直接 iframe 发来的消息；不兼容多层嵌套 iframe。
    if (event.source !== iframeRef.current?.contentWindow) {
      return
    }
    const iframeOrigin = getIframeOrigin(iframeRef)
    if (!iframeOrigin || event.origin !== iframeOrigin) {
      return
    }
    if (data.type !== 'dsh://native-notification') {
      return
    }
    const title = data.title ?? ''
    const body = data.body ?? ''
    const tag = data.tag === undefined || data.tag === null || data.tag === '' ? null : data.tag
    const sessionId = data.sessionId === undefined || data.sessionId === null || data.sessionId === '' ? null : data.sessionId
    if (
      typeof title !== 'string'
      || title.trim().length === 0
      || title.length > MAX_NOTIFICATION_TITLE_CHARS
      || typeof body !== 'string'
      || body.length > MAX_NOTIFICATION_BODY_CHARS
      || (tag !== null && (typeof tag !== 'string' || !isValidNotificationTag(tag)))
      || (sessionId !== null && (typeof sessionId !== 'string' || !isValidNotificationSession(sessionId)))
    ) {
      return
    }
    void invoke('show_native_notification', {
      payload: {
        title,
        body,
        tag,
        sessionId,
        requireInteraction: data.requireInteraction === true,
      },
    }).catch(error => console.error('[notification] show_native_notification failed:', error))
  }

  // 接收 iframe 的「插件异常上报」：记录到后端错误注册表并刷新插件列表。
  // 内嵌页面（或 dsh-tauri 扩展）捕获插件运行期异常后，以
  // `{ source: 'dsh-plugin-error-bridge', type: 'dsh://plugin-error', id, error }`
  // postMessage 到宿主，宿主经 `report_plugin_error` 持久化并推送新列表，
  // 「插件」面板据此展示 danger 图标与更新/卸载入口。
  function handlePluginError(event: MessageEvent<PluginErrorMessage>) {
    const data = event.data
    if (!data || typeof data !== 'object' || data.source !== 'dsh-plugin-error-bridge') {
      return
    }
    if (event.source !== iframeRef.current?.contentWindow) {
      return
    }
    const iframeOrigin = getIframeOrigin(iframeRef)
    if (!iframeOrigin || event.origin !== iframeOrigin) {
      return
    }
    if (
      data.type !== 'dsh://plugin-error'
      || typeof data.id !== 'string'
      || !isValidPluginId(data.id)
      || typeof data.error !== 'string'
      || data.error.trim().length === 0
      || data.error.trim().length > MAX_PLUGIN_ERROR_CHARS
    ) {
      return
    }
    const action = data.action ?? 'runtime'
    if (!PLUGIN_ERROR_ACTIONS.has(action)) {
      return
    }
    void invoke('report_plugin_error', {
      id: data.id,
      error: data.error,
      action,
    })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['plugins'] })
      })
      .catch(error => console.error('[plugin-error] report_plugin_error failed:', error))
  }

  // 接收 iframe 的「剪贴板图片回退」请求：读取系统剪贴板图片并把 PNG data URL 回传，
  // 使 Linux/WebKitGTK 下 dsh iframe 的贴图（paste 事件拿不到图片）能走原生剪贴板通路。
  function handleClipboardImage(event: MessageEvent<ClipboardImageRequest>) {
    const data = event.data
    if (!data || typeof data !== 'object' || data.source !== 'dsh-clipboard-image-bridge') {
      return
    }
    // 只接受 DSH 直接 iframe 发来的消息；不兼容多层嵌套 iframe。
    if (event.source !== iframeRef.current?.contentWindow) {
      return
    }
    const iframeOrigin = getIframeOrigin(iframeRef)
    if (!iframeOrigin || event.origin !== iframeOrigin) {
      return
    }
    if (data.type !== 'dsh://clipboard-image:read' || !data.id) {
      return
    }
    // 在闭包外把收窄后的值固定到局部常量，避免 TS 在闭包内丢失控制流收窄
    const reqId = data.id
    const origin = iframeOrigin
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
  }

  function handlePluginBoot(event: MessageEvent<PluginBootMessage>) {
    const data = event.data
    if (!data || typeof data !== 'object' || data.source !== 'dsh-plugin-boot-bridge') {
      return
    }
    if (event.source !== iframeRef.current?.contentWindow) {
      return
    }
    const iframeOrigin = getIframeOrigin(iframeRef)
    if (!iframeOrigin || event.origin !== iframeOrigin) {
      return
    }
    if (data.type === 'dsh://plugin-boot:ready') {
      store.harness.markIframeBootReady()
      return
    }
    if (data.type === 'dsh://plugin-boot:stalled') {
      void store.harness.recoverIframeBoot()
    }
  }

  useEvent('message', handleMessage)
  useEvent('message', handlePluginError)
  useEvent('message', handleClipboardImage)
  useEvent('message', handlePluginBoot)

  // 系统通知点击 → 通知 iframe 聚焦对应会话
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void listen<{ sessionId?: string | null, title?: string, tag?: string }>(
      'dsh-notification-clicked',
      (event) => {
        const payload = event.payload
        const iframeOrigin = getIframeOrigin(iframeRef)
        if (!iframeOrigin)
          return
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: 'dsh://focus-session',
            sessionId: payload.sessionId || undefined,
            title: payload.title || undefined,
            tag: payload.tag || undefined,
          },
          iframeOrigin,
        )
      },
    ).then((unlistener) => {
      // 订阅完成前若已卸载则立即释放，避免回调泄漏
      if (isMounted()) {
        unlisten = unlistener
      }
      else {
        unlistener()
      }
    })
    return () => {
      unlisten?.()
    }
  // eslint-disable-next-line react/exhaustive-deps
  }, [])

  // 将窗口可见性（最小化/隐藏/失焦）同步给 iframe，便于其暂停渲染
  function syncVisibility() {
    void (async () => {
      try {
        const appWindow = getCurrentWindow()
        const [minimized, visible] = await Promise.all([
          appWindow.isMinimized(),
          appWindow.isVisible(),
        ])
        const hidden = minimized || !visible
        const iframeOrigin = getIframeOrigin(iframeRef)
        if (!iframeOrigin)
          return
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'dsh://visibility-state', hidden },
          iframeOrigin,
        )
      }
      catch (error) {
        console.error('[notification] sync visibility failed:', error)
      }
    })()
  }

  // 窗口焦点/尺寸变化时即时同步可见性
  useEffect(() => {
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
        if (isMounted()) {
          unlisteners = [unFocus, unResized]
        }
        else {
          unFocus()
          unResized()
        }
      }
      catch (error) {
        console.error('[notification] visibility listeners failed:', error)
      }
    })()
    return () => {
      unlisteners.forEach(fn => fn())
    }
  // eslint-disable-next-line react/exhaustive-deps
  }, [])

  // 兜底轮询：覆盖监听不到的状态变化（如任务栏切换）；主路径是文档可见性事件，5s 足够
  useInterval(syncVisibility, 5000)
}
