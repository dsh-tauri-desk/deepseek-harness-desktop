import { useEffect } from 'react'
import { store } from '@/store'

/** 桌面端自更新轮询间隔：Rust 侧不再缓存，改为低频轮询以免触发 GitHub 未认证限流（60 次/小时/IP） */
const POLL_INTERVAL = 10 * 60_000

/**
 * 桌面端更新轮询：后台低频检查新版本（见 POLL_INTERVAL，Rust 侧不缓存、每次实时
 * 查询）。发现新版本时由 store 静默下载安装包，**不弹右下角 toast**——
 * 更新入口收敛到顶部导航栏的「更新可用」chip 与「帮助 > 检查更新」：
 * 二者都打开同一个对话框，里面才是下载进度与「打开安装包」。
 */
export function DesktopUpdater() {
  useEffect(() => {
    // 后台失败静默，不打扰用户
    void store.desktopUpdater.check().catch(() => {})
    const timer = setInterval(() => {
      void store.desktopUpdater.check().catch(() => {})
    }, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [])

  return null
}
