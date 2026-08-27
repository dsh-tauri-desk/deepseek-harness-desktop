import { useWatch } from '@hairy/react-lib'
import { useOverlay } from '@overlastic/react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { DesktopUpdateDialog } from '@/components/desktop-update-dialog'
import { store } from '@/store'
import { toast } from '@/utils/toast'

/** 桌面端自更新轮询间隔：走 tauri-plugin-updater 拉取 GitHub Release 的 latest.json（低频轮询，避免无谓请求） */
const POLL_INTERVAL = 10 * 60_000

/**
 * 桌面端「发现新版本」提示：后台低频轮询（见 POLL_INTERVAL），发现新版本时在
 * 右下角弹 toast。用户关闭后记住该版本，本次会话不再弹出；新版本出现仍会再次提示。
 */
export function DesktopUpdater() {
  const { t } = useTranslation()
  const { updateInfo, dismissedTag, downloading } = useStore(store.desktopUpdater)
  const openUpdateDialog = useOverlay(DesktopUpdateDialog)

  // 低频静默检查新版本（实时查询，无本地缓存）；后台失败静默，不打扰用户
  useEffect(() => {
    void store.desktopUpdater.check().catch(() => {})
    const timer = setInterval(() => {
      void store.desktopUpdater.check().catch(() => {})
    }, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [])

  useWatch([updateInfo, dismissedTag, downloading], () => {
    if (!updateInfo || downloading)
      return
    // 用户已关闭过该版本提示 → 不再弹出
    if (updateInfo.version === dismissedTag)
      return
    toast(t('update.available', { tag: updateInfo.version }), {
      actionProps: {
        children: t('update.now'),
        onPress: () => {
          toast.clear()
          // 打开更新对话框并开始下载安装（对话框内展示进度，完成后自动重启）
          openUpdateDialog()
          void store.desktopUpdater.updateNow()
        },
        variant: 'tertiary',
      },
      timeout: 0,
      placement: 'bottom end',
      description: t('update.desktop_new'),
      variant: 'default',
      onClose: () => store.desktopUpdater.dismissToast(),
    })
  }, { immediate: true })

  return null
}
