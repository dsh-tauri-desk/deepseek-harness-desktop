import type { IconComponent } from './loadable'
import type { SetupStatus } from '@/store/modules/harness'
import { ArrowDownToLine, CircleCheck, CircleExclamation, CircleInfo, Magnifier, Rocket } from '@gravity-ui/icons'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { Loadable } from './loadable'

// 各阶段对应不同图标，保持与 logo 一致的黑白中性色调
const STATUS_ICONS: Record<SetupStatus, IconComponent> = {
  checking: Magnifier,
  installing: ArrowDownToLine,
  starting: Rocket,
  preinstall: CircleInfo,
  ready: CircleCheck,
  error: CircleExclamation,
}

/**
 * 安装/更新页：基于通用 Loadable 组件渲染，
 * 视觉与官方 web shell 的 boot 加载页（AppRoot）一致。
 * 状态与重试动作直接从 harness store 读取，不再接收 props。
 */
export function Setup() {
  const { t } = useTranslation()
  const {
    status,
    installer,
    errorMsg,
    errorLogs,
    pluginConflictHint,
    inotifyLimitHint,
  } = useStore(store.harness)
  const error = status === 'error'
  const installing = status === 'installing'
  const heading = error ? t('status.error') : installer.title || t('status.installing')
  const description = error ? '' : installer.detail || t('status.installing')
  const StatusIcon = STATUS_ICONS[status]
  // 安装中展示安装日志；错误态展示启动失败时从 dsh 服务日志读取的真实错误行
  const logs = installing
    ? installer.logs
    : (error && errorLogs.length > 0 ? errorLogs : undefined)
  // 错误态的针对性提示：插件路由冲突 / Linux inotify 文件监视上限，二选一优先展示
  const hint = error ? (pluginConflictHint || inotifyLimitHint) : undefined

  return (
    <Loadable
      icon={StatusIcon}
      title={heading}
      subtitle={error ? undefined : description}
      percentage={installing ? installer.percentage : undefined}
      logs={logs}
      errorMsg={error ? errorMsg : undefined}
      onRetry={error ? store.harness.boot : undefined}
    >
      {hint && (
        <p className="m-0 text-xs leading-[18px] break-all text-load-muted">{hint}</p>
      )}
    </Loadable>
  )
}
