import type { DesktopAboutInfo, DesktopUpdateInfo } from './types'
import { invoke } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { check as checkUpdate } from '@tauri-apps/plugin-updater'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { toast } from '@/utils/toast'

const DISMISS_KEY = 'desktop-update-dismissed-tag'

/**
 * 桌面端自更新模块：检查新版本 → 弹出更新对话框 → 下载并安装 → 重启应用。
 *
 * 与 `updater` 模块（dsh 内核更新）区分：本模块针对桌面应用自身。
 * 底层由官方 `tauri-plugin-updater` 提供：检查 / 下载 / 安装 / 重启全部走
 * 插件（Ed25519 签名校验），前端只做编排与进度展示。
 *
 * 正式版策略：仅对**纯数字版本**（如 0.8.6）提示更新，rc/beta 等 pre-release
 * 一律跳过（与旧实现 version.rs::is_stable 语义一致）。
 * Linux 注意：插件仅支持 AppImage 部署，deb/rpm 安装不提示（见
 * desktop_update_supported），保持从发布页手动下载。
 */
function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

function readDismissedTag(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? ''
  }
  catch {
    return ''
  }
}

export const desktopUpdater = defineStore({
  state: () => ({
    /** 发现的新版本信息（null 表示暂无） */
    updateInfo: null as DesktopUpdateInfo | null,
    /** 是否正在检查更新（避免并发/重复） */
    checking: false,
    /** 是否正在下载安装更新 */
    downloading: false,
    /** 下载进度 0-100 */
    downloadProgress: 0,
    /** 关于对话框信息 */
    about: null as DesktopAboutInfo | null,
    /** 用户已关闭提示的版本号（持久化，同版本不再弹 toast） */
    dismissedTag: readDismissedTag(),
  }),
  actions: {
    /**
     * 检查是否有新版本。
     * 轮询与「检查更新」共用；仅在版本号变化时更新 updateInfo，
     * 既避免重复弹 toast，也让菜单「存在新版本」指示实时反映。
     * 网络失败/限流时抛出错误（不吞掉），由调用方决定如何提示——
     * 绝不能把「检查失败」误报成「已是最新」。
     */
    async check(): Promise<DesktopUpdateInfo | null> {
      if (this.checking)
        return this.updateInfo
      this.checking = true
      try {
        // Linux deb/rpm 安装不支持应用内自动更新（仅 AppImage），不提示
        const supported = await invoke<boolean>('desktop_update_supported')
        if (!supported) {
          this.updateInfo = null
          return null
        }
        const update = await checkUpdate()
        if (update && isStableVersion(update.version)) {
          if (this.updateInfo?.version !== update.version) {
            this.updateInfo = {
              version: update.version,
              currentVersion: update.currentVersion,
              date: update.date ?? null,
              body: update.body ?? null,
            }
          }
        }
        else {
          this.updateInfo = null
        }
        return this.updateInfo
      }
      finally {
        this.checking = false
      }
    },

    /** 用户关闭 toast 提示：记住该版本，本次会话不再弹出 */
    dismissToast() {
      const version = this.updateInfo?.version
      if (!version)
        return
      this.dismissedTag = version
      try {
        localStorage.setItem(DISMISS_KEY, version)
      }
      catch {
        /* 忽略持久化失败 */
      }
    },

    /** 加载关于信息（缓存到 store，仅首次拉取；打开关于对话框前调用） */
    async loadAbout(): Promise<DesktopAboutInfo | null> {
      if (!this.about) {
        try {
          this.about = await invoke<DesktopAboutInfo>('get_desktop_about')
        }
        catch (err) {
          console.warn('[DesktopUpdater] failed to load about info:', err)
        }
      }
      return this.about
    },

    /**
     * 立即更新：下载 → 安装 → 重启应用。
     * 下载期间由插件回调更新 downloadProgress；安装完成后调用 relaunch
     * 重启以应用新版本（macOS/Linux 需显式 relaunch，Windows 由安装器处理）。
     * 失败时 toast 提示，不阻断当前会话。
     */
    async updateNow() {
      if (this.downloading)
        return
      this.downloading = true
      this.downloadProgress = 0
      let received = 0
      let total = 0
      try {
        const supported = await invoke<boolean>('desktop_update_supported')
        if (!supported)
          return
        const update = await checkUpdate()
        if (!update || !isStableVersion(update.version))
          return
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? 0
          }
          else if (event.event === 'Progress') {
            received += event.data.chunkLength
            if (total > 0)
              this.downloadProgress = Math.min(100, (received / total) * 100)
          }
        })
        // 安装完成 → 重启应用应用新版本
        await relaunch()
      }
      catch (err) {
        console.error('[DesktopUpdater] update failed:', err)
        toast(i18next.t('update.desktop_install_failed'), {
          variant: 'danger',
          placement: 'bottom end',
        })
      }
      finally {
        this.downloading = false
        this.downloadProgress = 0
      }
    },
  },
})
