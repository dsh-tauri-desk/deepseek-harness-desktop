import { Check, FaceRobot } from '@gravity-ui/icons'
import { Button, Description, Spinner, Surface, Switch } from '@heroui/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useAppConfig } from '@/hooks/use-app-config'
import { toast } from '@/utils/toast'

/** 桌宠状态（Rust `bridge::pet::PetStatus`，snake_case 契约）。 */
export interface PetStatus {
  enabled: boolean
  visible: boolean
  active_pet_id: string
}

/** 内置默认宠物列表（id → 名称/描述；占位猫咪，未来接入 spritesheet 时替换预览）。 */
const BUILTIN_PETS: { id: string, nameKey: string, descKey: string }[] = [
  { id: 'cat', nameKey: 'pet.pet_cat_name', descKey: 'pet.pet_cat_desc' },
]

export function ConfigPet() {
  const { t } = useTranslation()
  const { data: config, refetch: refreshConfig } = useAppConfig()

  const { data: status, refetch: refreshStatus } = useQuery({
    queryKey: ['pet_status'],
    queryFn: () => invoke<PetStatus>('get_pet_status'),
  })

  const { data: importedPets } = useQuery({
    queryKey: ['pet_list'],
    queryFn: () => invoke<string[]>('list_pets'),
  })

  const { mutate: onToggleEnabled, isPending: toggling } = useMutation({
    mutationFn: async (enabled: boolean) => {
      await invoke<PetStatus>('set_pet_enabled', { enabled })
      await refreshStatus()
      await refreshConfig()
      toast(enabled ? t('pet.enabled_toast') : t('pet.disabled_toast'), {})
    },
    onError: (err: unknown) => {
      console.error('[ConfigPet] toggle enabled failed:', err)
      toast(t('pet.operation_failed'), { variant: 'danger' })
    },
  })

  const { mutate: onSelectPet, isPending: selecting } = useMutation({
    mutationFn: async (petId: string) => {
      await invoke<PetStatus>('set_active_pet', { petId })
      await refreshStatus()
      await refreshConfig()
    },
    onError: (err: unknown) => {
      console.error('[ConfigPet] select pet failed:', err)
      toast(t('pet.operation_failed'), { variant: 'danger' })
    },
  })

  const enabled = status?.enabled ?? config?.pet_enabled ?? false
  const activeId = status?.active_pet_id ?? config?.active_pet_id ?? 'cat'
  const busy = toggling || selecting

  const pets = [...BUILTIN_PETS]
  for (const id of importedPets ?? []) {
    if (!pets.some(pet => pet.id === id)) {
      pets.push({ id, nameKey: id, descKey: 'pet.pet_imported_desc' })
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg bg-background-secondary px-3 py-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">{t('pet.title')}</span>
          <Description className="text-[11px] text-muted/70">{t('pet.description')}</Description>
        </div>
        <Switch
          isSelected={enabled}
          onChange={onToggleEnabled}
          isDisabled={busy}
          aria-label={t('pet.title')}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {pets.map((pet) => {
          const isActive = pet.id === activeId
          return (
            <Surface
              key={pet.id}
              className={`rounded-lg p-3 border ${isActive ? 'border-accent/60' : 'border-line/40'}`}
            >
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-full bg-background-secondary text-accent">
                    <FaceRobot className="size-5" />
                  </span>
                  <If
                    cond={isActive}
                    then={(
                      <Button size="sm" variant="secondary" className="rounded-md h-7 px-2 text-xs" isDisabled>
                        <Check className="size-3.5" />
                        {t('pet.selected')}
                      </Button>
                    )}
                    else={(
                      <Button
                        size="sm"
                        variant="ghost"
                        className="rounded-md h-7 px-2 text-xs"
                        isDisabled={busy}
                        onPress={() => onSelectPet(pet.id)}
                      >
                        <If cond={selecting && activeId !== pet.id} then={<Spinner size="sm" color="current" />} else={<span>{t('pet.select')}</span>} />
                      </Button>
                    )}
                  />
                </div>
                <span className="text-xs font-medium text-ink">{pet.nameKey}</span>
                <Description className="text-[10px] leading-snug text-muted/70">
                  {pet.descKey}
                </Description>
              </div>
            </Surface>
          )
        })}
      </div>

      <Description className="text-[10px] text-muted/60">{t('pet.footer_hint')}</Description>
    </div>
  )
}
