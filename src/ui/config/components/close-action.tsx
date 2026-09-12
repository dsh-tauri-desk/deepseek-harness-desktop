import type { AppSettingUpdate } from '@/store/modules/setting'
import { Description, ListBox, Select } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { CLOSE_ACTION_OPTIONS, normalizeCloseAction } from '@/utils/close-action'
import { toast } from '@/utils/toast'

const CLOSE_ACTION_LABEL_KEYS = {
  tray: 'ui.close_action_tray',
  quit: 'ui.close_action_quit',
}

/**
 * 关闭按钮行为（隐藏到托盘 / 退出）。
 *
 * 读：`setting` store（与 Rust 共享 `.store.dat`，后端改动经 `setting_updated` 回流）。
 * 写：仍走 `update_app_config`，让后端统一归一化并在锁内落盘——前端直接改 store
 * 会与 Rust 的整对象写入互相覆盖。
 * 因此这里既不需要配置查询，也不需要写入后手动刷新。
 */
export function ConfigCloseAction() {
  const { t } = useTranslation()
  const { close_action: closeAction } = useStore(store.setting)
  const { mutate: setCloseAction, isPending } = useMutation({
    mutationFn: (next: string) =>
      // `satisfies` 用共享类型守住 camelCase 契约：字段名写错时后端会静默忽略
      invoke('update_app_config', { closeAction: normalizeCloseAction(next) } satisfies AppSettingUpdate),
    onError: (error: unknown) => {
      console.error('[ConfigCloseAction] update failed:', error)
      toast(t('messages.close_action_failed'), { variant: 'danger' })
    },
  })

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink">{t('ui.close_action')}</span>
        <Select
          variant="secondary"
          selectedKey={normalizeCloseAction(closeAction)}
          onSelectionChange={key => setCloseAction(String(key))}
          isDisabled={isPending}
          className="w-[140px]"
          aria-label={t('ui.close_action')}
        >
          <Select.Trigger className="rounded-md min-h-8! h-8 py-0 items-center">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover className="rounded-md">
            <ListBox>
              {CLOSE_ACTION_OPTIONS.map(action => (
                <ListBox.Item
                  className="rounded-md min-h-8!"
                  id={action}
                  key={action}
                  textValue={t(CLOSE_ACTION_LABEL_KEYS[action])}
                >
                  {t(CLOSE_ACTION_LABEL_KEYS[action])}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      <Description className="text-[10px] text-muted/70">
        {t('ui.close_action_hint')}
      </Description>
    </div>
  )
}
