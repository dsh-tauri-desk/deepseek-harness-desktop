import { Description, Switch } from '@heroui/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { toast } from '@/utils/toast'

export function ConfigLaunchOnLogin() {
  const { t } = useTranslation()
  const { data: enabled, refetch, isFetching } = useQuery({
    queryKey: ['launch_on_login'],
    queryFn: () => invoke<boolean>('get_launch_on_login'),
  })
  const { mutate: setEnabled, isPending } = useMutation({
    mutationFn: (nextEnabled: boolean) => invoke<boolean>('set_launch_on_login', { enabled: nextEnabled }),
    onSuccess: () => {
      void refetch()
    },
    onError: (error: unknown) => {
      console.error('[ConfigLaunchOnLogin] update failed:', error)
      toast(t('messages.launch_on_login_failed'), { variant: 'danger' })
    },
  })

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink">{t('ui.launch_on_login')}</span>
        <Switch
          isSelected={enabled ?? false}
          isDisabled={isFetching || isPending}
          onChange={setEnabled}
          aria-label={t('ui.launch_on_login')}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </div>
      <Description className="text-[10px] text-muted/70">
        {t('ui.launch_on_login_hint')}
      </Description>
    </div>
  )
}
