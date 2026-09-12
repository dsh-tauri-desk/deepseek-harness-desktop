import type { PropsWithOverlays } from '@overlastic/react'
import { AlertDialog, Button, Description, ProgressBar } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { Info } from '@/components/info'
import { store } from '@/store'

export interface DesktopUpdateDialogProps extends PropsWithOverlays {}

/**
 * 「检查更新」对话框：展示新版本信息 + 下载进度。
 *
 * 两个入口共用（顶部「更新可用」chip / 帮助菜单「检查更新」）：
 * - 检测到更新后 store 已在静默下载 → 打开即展示进度条；此时点「立即更新」会
 *   等待这次下载结束，完成后再打开安装包（不会重复下载）；
 * - 已下载 → 「打开安装包」直接交给系统安装器；
 * - 未下载（上次下载失败等）→ 「立即更新」重新下载，完成后自动打开安装包。
 *
 * 注意：后台静默下载完成时**不**自动关闭/打开——只有用户点了主按钮才交给安装器，
 * 否则用户刚打开的对话框会在下载完成时莫名消失。
 *
 * 对话框在下载中同样可关闭：下载由 store 驱动、与对话框生命周期无关，锁住弹窗
 * 只会让「打开看进度」的用户无法退出（更新入口 chip 常驻，随时能再打开）。
 */
export function DesktopUpdateDialog(props: DesktopUpdateDialogProps) {
  const disclosure = useDisclosure({ props })
  const { t } = useTranslation()
  const { updateInfo, downloading, downloadProgress } = useStore(store.desktopUpdater)

  /** 主按钮：已下载直接打开；未下载则等待/发起下载，完成后打开安装器 */
  async function handlePrimary() {
    const info = store.desktopUpdater.updateInfo
    if (!info)
      return
    if (info.downloaded) {
      await store.desktopUpdater.openInstaller(info.path)
      disclosure.cancel()
      return
    }
    await store.desktopUpdater.downloadAndOpen()
    // 下载成功（安装包已交给系统）→ 收起对话框；失败保持打开，用户可重试
    if (store.desktopUpdater.updateInfo?.downloaded)
      disclosure.cancel()
  }

  return (
    <AlertDialog onOpenChange={disclosure.cancel} isOpen={disclosure.visible}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="default" />
              <AlertDialog.Heading>{t('update.desktop_title')}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="space-y-3">
              <If cond={updateInfo != null}>
                <div className="space-y-1.5">
                  <Info term={t('ui.current_version')}>{updateInfo?.currentVersion}</Info>
                  <Info term={t('update.new_version_label')}>{updateInfo?.version}</Info>
                  <If cond={updateInfo?.downloaded}>
                    <Description className="text-xs">
                      {t('update.desktop_downloaded')}
                    </Description>
                  </If>
                </div>
              </If>

              <If cond={downloading}>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted">
                    <span>{t('update.desktop_downloading')}</span>
                    <span className="shrink-0">
                      {Math.round(downloadProgress)}
                      %
                    </span>
                  </div>
                  <ProgressBar value={downloadProgress} className="w-full">
                    <ProgressBar.Track>
                      <ProgressBar.Fill className="bg-accent" />
                    </ProgressBar.Track>
                  </ProgressBar>
                </div>
              </If>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                variant="tertiary"
                className="rounded-md"
                onPress={disclosure.cancel}
              >
                {t('update.later')}
              </Button>
              <Button
                variant="primary"
                className="rounded-md"
                isDisabled={updateInfo == null}
                onPress={handlePrimary}
              >
                {updateInfo?.downloaded
                  ? t('update.open_installer')
                  : t('update.now')}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
