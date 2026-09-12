import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app'
import { reportPetIssue } from './utils/log'
import './main.css'

/**
 * 把**远端 https 请求**交给 Tauri HTTP 插件，其余请求原样走原生 `fetch`。
 *
 * 目的：预设宠物素材直连 `raw.githubusercontent.com`。该主机其实返回
 * `Access-Control-Allow-Origin: *`，但插件版由 Rust 发起请求，不受同源策略、
 * CSP connect-src 与企业代理拦截影响，行为更可控。
 *
 * 为什么必须限定 `https://`：整体替换 `window.fetch` 会连带劫持**同源请求** ——
 * 开发模式下 Vite 客户端用 `fetch` 拉取热更新后的样式文本（`http://localhost:1420/...`），
 * 而插件 scope 只允许素材主机，请求被拒 → 样式热更新失败并触发整页重载，桌宠窗口在
 * 开发时被反复重建。生产环境同样不该让桌宠窗口失去同源 fetch 能力。
 */
const nativeFetch = globalThis.fetch
const pluginFetch = tauriFetch as unknown as typeof globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
  return url.startsWith('https://')
    ? pluginFetch(input, init)
    : nativeFetch(input, init)
}) as typeof globalThis.fetch

// 桌宠窗口没有任何日志出口：把未捕获异常与未处理的 Promise 拒绝转发进应用日志，
// 否则「窗口空白 / 页面崩溃」在日志里完全不可见，只能靠手动 F12。
globalThis.addEventListener('error', (event) => {
  reportPetIssue('window error', `${event.message} @ ${event.filename}:${event.lineno}`)
})
globalThis.addEventListener('unhandledrejection', (event) => {
  reportPetIssue('unhandled rejection', (event as PromiseRejectionEvent).reason)
})

const root = document.getElementById('root') as HTMLElement
root.className = 'h-full w-full'

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
