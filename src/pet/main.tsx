import React from 'react'
import ReactDOM from 'react-dom/client'
import { disableWakeLock } from '@/utils/disable-wake-lock'
import { App } from './app'
import './main.css'

const root = document.getElementById('root') as HTMLElement
root.className = 'h-full w-full'

// 桌宠动画是常驻播放的 <video>：Chromium 会因此持有 Video Wake Lock，让系统无法息屏
// （issue #469）。渲染前禁用屏幕唤醒锁，收起宠物/窗口隐藏时都不会再阻止息屏。
disableWakeLock()

// 禁用桌宠窗口右键菜单：桌宠窗口是装饰性的透明置顶小窗，右键不应弹出
// WebView 默认 context menu（Chromium/WebView2 尊重 contextmenu 的 preventDefault）。
window.addEventListener('contextmenu', event => event.preventDefault(), { capture: true })

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
