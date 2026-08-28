import { Description, Label, Spinner, Switch } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { toast } from '@/utils/toast'
import { useTrustMode } from '../hooks/use-trust-mode'
import { Item } from './item'
import { PanelHeader } from './panel-header'

/**
 * 「信任模式」面板：开关 Harness 的权限审批方式。
 *
 * Harness 官方把「沙箱模式 + 审批策略」打包为权限预设，默认 `workspace-write`
 * 会在命令需要更高权限时逐次弹窗确认（fail-closed）。开启信任模式即把默认
 * 预设切到 `danger-full-access`（非受限沙箱 + 不再询问），省掉高频开发场景里
 * 的重复确认。
 *
 * 真源是 Harness 的 `settings.yaml`（见 `useTrustMode`），因此这里只是开关：
 * 不额外维护一份桌面端状态。变更对**之后新建的会话**生效——会话创建时即固定
 * 其权限，既有会话不会被追溯改写，所以提示语指向「新开会话」而非「重启服务」。
 */
export function ConfigTrustMode() {
  const { t } = useTranslation()
  const { enabled, loading, busy, setEnabled } = useTrustMode()

  async function onToggle(next: boolean) {
    try {
      await setEnabled(next)
      toast(next ? t('trust.enabled_toast') : t('trust.disabled_toast'), {
        variant: 'accent',
        description: t('trust.next_session_hint'),
        timeout: 8000,
      })
    }
    catch (err) {
      console.error('[ConfigTrustMode] toggle failed:', err)
      toast(t('trust.toggle_failed'), {})
    }
  }

  return (
    <div className="space-y-3">
      <PanelHeader title={t('trust.title')} description={t('trust.tooltip')} />
      <Item
        left={(
          <Label className="text-sm font-medium text-ink">
            {t('trust.enable')}
          </Label>
        )}
        right={(
          <>
            <If cond={busy}>
              <Spinner size="sm" color="current" />
            </If>
            <Switch
              isSelected={enabled}
              isDisabled={loading || busy}
              onChange={next => onToggle(next)}
              aria-label={t('trust.enable')}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </>
        )}
        footer={(
          <div className="flex flex-col gap-0.5">
            <Description className="text-[10px] text-muted/70">
              {t('trust.enable_desc')}
            </Description>
            <Description className="text-[10px] text-muted/70">
              {t('trust.next_session_hint')}
            </Description>
          </div>
        )}
      />
    </div>
  )
}
