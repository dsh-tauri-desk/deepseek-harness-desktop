import { OverlaysProvider } from '@overlastic/react'
import { QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ToastProvider } from './components/toast-provider'
import { queryClient } from './config/client'
import { App } from './layout'
import { disableWakeLock } from './utils/disable-wake-lock'
import '@/utils/logger'
import './style/main.css'

// 渲染前先禁用屏幕唤醒锁：本应用无需屏幕常亮，任何 <video> 播放都会让系统无法息屏（issue #469）。
disableWakeLock()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <OverlaysProvider>
          <App />
        </OverlaysProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
