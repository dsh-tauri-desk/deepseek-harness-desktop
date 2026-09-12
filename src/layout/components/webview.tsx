import { useRef, useState } from 'react'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { useIframeMessage } from '@/hooks/use-iframe-message'
import { useIframePost } from '@/hooks/use-iframe-post'
import { store } from '@/store'
import { Recovery } from '@/ui/plugin/recovery'
import { Iframe } from './iframe'
import { Navbar } from './navbar'
import { Setup } from './setup'
import { PreinstallSetup } from './setup-preinstall'

/** 导航桥回报（iframe → 宿主）：侧边栏折叠状态 */
interface NavBridgeMessage {
  type?: string
  collapsed?: boolean
}

/**
 * 主区域视图：壳层导航栏（Navbar）常驻顶部，按 harness 状态切换内容——
 * 错误态 Setup / 插件恢复页，预装引导 PreinstallSetup，其余未就绪态 Setup，
 * 就绪态渲染 iframe。
 *
 * 分工：
 * - iframe 元素及 iframe 自身的桥在 `iframe.tsx`（通知 / 插件异常 / 剪贴板图片 / boot / 可见性）；
 * - 导航桥属于导航栏的状态，留在这里：用同一份 `useIframeMessage` / `useIframePost`
 *   接收 `dsh://sidebar:collapsed` 回报、发送 `dsh://sidebar:toggle` 命令。
 */
export function Webview() {
  // iframe 内 dsh 侧边栏是否折叠（由导航桥回报）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const { status } = useStore(store.harness)
  const { recovery } = useStore(store.recovery)

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const post = useIframePost(iframeRef)

  useIframeMessage<NavBridgeMessage>(iframeRef, (data) => {
    if (data.type === 'dsh://sidebar:collapsed')
      setSidebarCollapsed(Boolean(data.collapsed))
  })

  if (status === 'error') {
    return (
      <main className="relative flex min-h-0 flex-1 flex-col bg-canvas">
        <Navbar />
        <div className="min-h-0 flex-1">
          {/* 能定位到问题插件时展示全屏恢复页（卸除此插件并继续检测）；否则普通错误页 */}
          <If cond={recovery.required} else={<Setup />}>
            <Recovery fullScreen />
          </If>
        </div>
      </main>
    )
  }

  // 预装插件引导：独立于安装/加载界面，渲染推荐插件列表与安装控制台
  if (status === 'preinstall') {
    return (
      <main className="relative flex min-h-0 w-full flex-col bg-canvas">
        <Navbar />
        <div className="min-h-0 flex-1">
          <PreinstallSetup />
        </div>
      </main>
    )
  }

  if (status !== 'ready') {
    return (
      <main className="relative flex min-h-0 w-full flex-col bg-canvas">
        <Navbar />
        <div className="min-h-0 flex-1">
          <Setup />
        </div>
      </main>
    )
  }

  return (
    <main className="relative flex min-h-0 flex-1 flex-col bg-canvas">
      <Navbar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => post({ type: 'dsh://sidebar:toggle' })}
      />
      <Iframe iframeRef={iframeRef} />
    </main>
  )
}
