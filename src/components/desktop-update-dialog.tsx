import type { PropsWithOverlays } from '@overlastic/react'
import { AlertDialog, Button, Description, ProgressBar } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { Info } from './info'

export interface DesktopUpdateDialogProps extends PropsWithOverlays {}

/**
 * 「检查更新」对话框：展示新版本信息 + 下载进度。
 * 点击「重启以更新」触发 `store.desktopUpdater.updateNow()`：由
 * tauri-plugin-updater 下载并安装，完成后自动重启应用（对话框随之消失）。
 * 更新失败时对话框保持打开，可重试或稍后再更新（toast 已提示原因）。
 *
 * 使用 overlastic 命令式打开（`useOverlay(DesktopUpdateDialog)`）。
 * 外部触发（右下角 toast）时由调用方先 openUpdateDialog() 再调 updateNow()，
 * 进度事件驱动进度条展示。
 */
export function DesktopUpdateDialog(props: DesktopUpdateDialogProps) {
  const disclosure = useDisclosure({ props })
  const { t } = useTranslation()
  const { updateInfo, downloading, downloadProgress } = useStore(store.desktopUpdater)

  async function handlePrimary() {
    await store.desktopUpdater.updateNow()
  }

  return (
    <AlertDialog onOpenChange={disclosure.cancel} isOpen={disclosure.visible}>
      <AlertDialog.Backdrop isDismissable={!downloading}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]">
            <AlertDialog.CloseTrigger isDisabled={downloading} />
            <AlertDialog.Header>
              <AlertDialog.Icon status="default" />
              <AlertDialog.Heading>{t('update.desktop_title')}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="space-y-3">
              <If cond={updateInfo != null}>
                <div className="space-y-1.5">
                  <Info term={t('ui.current_version')}>{updateInfo?.currentVersion}</Info>
                  <Info term={t('update.new_version_label')}>{updateInfo?.version}</Info>
                  <Description className="text-xs">
                    {t('update.restart_hint')}
                  </Description>
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
                isDisabled={downloading}
                onPress={disclosure.cancel}
              >
                {t('update.later')}
              </Button>
              <Button
                variant="primary"
                className="rounded-md"
                isDisabled={downloading || updateInfo == null}
                onPress={handlePrimary}
              >
                {t('update.restart')}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
