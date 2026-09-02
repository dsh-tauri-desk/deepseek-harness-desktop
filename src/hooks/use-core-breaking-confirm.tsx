import { useOverlay } from '@overlastic/react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@/components/modal'
import { CORE_BREAKING_BASELINE, isCoreBreakingVersion } from '@/utils/core-version'

/**
 * rc.2 以上版本的下载前确认：若目标核心版本高于 rc.2 基准（引入破坏性更改、
 * 可能影响第三方插件），先弹出确认对话框；取消则中止，确认后继续。
 *
 * 该逻辑与「推荐版本」逻辑无关，仅用于提示用户，提示可随时在核心中切回 rc.2。
 * 三个入口（核心面板下载、核心「发现新版本」toast、debug「存在新版本」链接）
 * 共用此一份逻辑。
 */
export function useCoreBreakingConfirm() {
  const [holder, openDialog] = useOverlay(Modal, { type: 'holder' })
  const { t } = useTranslation()

  /** 返回 true=继续下载，false=用户取消。版本高于 rc.2 时弹确认框，否则直接放行 */
  async function confirmCoreBreaking(version: string): Promise<boolean> {
    if (!isCoreBreakingVersion(version))
      return true
    try {
      await openDialog({
        status: 'warning',
        title: t('core.above_rc2_warning_title'),
        description: (
          <p>
            {t('core.above_rc2_warning_desc', { version: CORE_BREAKING_BASELINE })}
          </p>
        ),
      })
      return true
    }
    catch {
      return false
    }
  }

  return { holder, confirmCoreBreaking }
}
