import type { Profile } from '@/types'
import { Plus } from '@gravity-ui/icons'
import { AlertDialog, Button, Checkbox, Chip, Description, Input, Label } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useToggle } from '@reause/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'

import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { Ellipsis } from '@/components/ellipsis'
import { Item } from '@/components/item'
import { Modal } from '@/components/modal'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { useInvalidateOnSettingUpdated } from '@/hooks/use-invalidate-on-setting-updated'
import { store } from '@/store'
import { ConfigBackup } from '@/ui/config/backup'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'

type ProfileView = 'list' | { profile: string }

export function ConfigProfile() {
  /**
   * 「档案」面板：展示 & 切换 dsh 配置档案，支持新建/删除。
   *
   * 档案 = `$DSH_HOME/profiles/<id>` 目录，与官方 dsh CLI 的 profile 语义一致；
   * 桌面端把「当前档案」持久化在 store（`active_profile`），服务启动与插件管理
   * 都以它为准。切换档案需要重启服务才生效（toast 内提供重启入口）。
   */
  const queryClient = useQueryClient()
  const { data: profileList, isLoading, error: profileError, refetch } = useQuery({
    queryKey: queryKeys.profiles,
    queryFn: () => invoke<Profile[]>('get_profiles'),
  })
  // 切换档案会写桌面端 store（触发 `setting_updated`），监听该事件一并失效重拉，
  // 保证面板列表与后端设置始终一致。
  useInvalidateOnSettingUpdated(queryKeys.profiles)

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.profiles })
  }

  const create = useMutation({
    mutationFn: (name: string) => invoke<Profile>('create_profile', { name }),
    onSuccess: invalidate,
  })
  const activate = useMutation({
    mutationFn: (id: string) => invoke<Profile>('set_active_profile', { id }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => invoke<void>('remove_profile', { id }),
    onSuccess: invalidate,
  })
  const clone = useMutation({
    mutationFn: (params: { sourceId: string, name: string }) => invoke<Profile>('clone_profile', params),
    onSuccess: invalidate,
  })

  /** 写操作封装：等待列表重拉完成再返回，调用方拿到的列表与后端一致 */
  async function createProfile(name: string): Promise<Profile> {
    const created = await create.mutateAsync(name)
    await refetch()
    return created
  }

  async function activateProfile(id: string): Promise<Profile> {
    const activated = await activate.mutateAsync(id)
    await refetch()
    return activated
  }

  async function removeProfile(id: string) {
    await remove.mutateAsync(id)
    await refetch()
  }

  async function cloneProfile(sourceId: string, name: string): Promise<Profile> {
    const created = await clone.mutateAsync({ sourceId, name })
    await refetch()
    return created
  }

  const profiles = profileList ?? []
  const loading = isLoading
  const error = profileError ? String(profileError) : ''
  /** 操作进行中标记（新建/切换/删除/克隆任一） */
  const busy = create.isPending || activate.isPending || remove.isPending || clone.isPending

  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })

  const { t } = useTranslation()
  const [creating, toggleCreating] = useToggle()
  const [name, setName] = useState('')
  const [activeView, setActiveView] = useState<ProfileView>('list')

  // 克隆档案：命名对话框状态
  const [cloning, setCloning] = useState<{ sourceId: string, sourceName: string } | null>(null)
  const [cloneName, setCloneName] = useState('')

  /** 推导下一个未占用的自动递增名称（仅作为建议，后端才是权威） */
  function suggestCloneName(base: string): string {
    const taken = new Set(profiles.map(p => p.id))
    for (let n = 1; n <= 1000; n++) {
      const candidate = `${base}-${n}`
      if (!taken.has(candidate))
        return candidate
    }
    return `${base}-1`
  }

  function openCloneDialog(profile: { id: string, name: string }) {
    setCloning({ sourceId: profile.id, sourceName: profile.name })
    setCloneName(suggestCloneName(profile.id))
  }

  async function commitClone() {
    if (!cloning)
      return
    const trimmed = cloneName.trim()
    if (!trimmed) {
      toast(t('profiles.clone_empty'), {})
      return
    }
    try {
      await cloneProfile(cloning.sourceId, trimmed)
      setCloning(null)
      setCloneName('')
      toast(t('profiles.clone_success', { name: trimmed }), {
        variant: 'accent',
        description: t('profiles.clone_success_hint'),
        timeout: 10_000,
      })
    }
    catch (err) {
      console.error('[ConfigProfile] clone failed:', err)
      toast(t('profiles.clone_failed'), {})
    }
  }

  async function onActivate(id: string) {
    const target = profiles.find(p => p.id === id)
    if (!target || target.active || busy)
      return
    try {
      await openDialog({
        status: 'warning',
        title: t('profiles.activate_confirm_title'),
        description: (
          <p>
            {t('profiles.activate_confirm_desc', { name: target.name })}
          </p>
        ),
      })
    }
    catch (e) {
      silence(e, 'profile activate: dialog cancelled')
      return
    }
    try {
      await activateProfile(id)
      const key = toast(t('profiles.activate_toast', { name: target.name }), {
        variant: 'accent',
        description: t('profiles.activate_restart_hint'),
        timeout: 10_000,
        actionProps: {
          children: t('app.restart'),
          onPress: () => {
            store.harness.restart()
            toast.close(key)
          },
        },
      })
    }
    catch (err) {
      console.error('[ConfigProfile] activate failed:', err)
      toast(t('profiles.activate_failed', { name: target.name }), {})
    }
  }

  function startCreate() {
    toggleCreating(true)
    setName('')
  }

  function cancelCreate() {
    toggleCreating(false)
    setName('')
  }

  async function commitCreate() {
    const trimmed = name.trim()
    if (!trimmed)
      return
    try {
      // 创建成功后列表已刷新出新档案，UI 本身就有变化，不再弹成功 toast
      await createProfile(trimmed)
      toggleCreating(false)
      setName('')
    }
    catch (err) {
      console.error('[ConfigProfile] create failed:', err)
      toast(t('profiles.create_failed'), {})
    }
  }

  async function onRemove(id: string) {
    const target = profiles.find(p => p.id === id)
    if (!target || busy)
      return
    try {
      await openDialog({
        title: t('profiles.remove_confirm_title'),
        status: 'danger',
        description: (
          <p>
            {t('profiles.remove_confirm_desc', { name: target.name })}
          </p>
        ),
        confirmText: t('profiles.remove_confirm'),
      })
    }
    catch (e) {
      silence(e, 'profile remove: dialog cancelled')
      return
    }
    try {
      // 删除成功后列表已移除该档案，UI 本身就有变化，不再弹成功 toast
      await removeProfile(id)
    }
    catch (err) {
      console.error('[ConfigProfile] remove failed:', err)
      toast(t('profiles.remove_failed'), {})
    }
  }

  // 备份子视图：点击档案的「备份」芯片后进入
  if (activeView !== 'list') {
    return (
      <ConfigBackup onBack={() => setActiveView('list')} />
    )
  }

  return (
    <div className="space-y-3">
      <Panel.Header title={t('profiles.title')} description={t('profiles.tooltip')} />

      {/* 加载 / 失败 / 列表 */}
      <Panel.Loadable loading={loading} error={error}>
        <div className="flex flex-col gap-4">
          {profiles.map(profile => (
            <Item
              key={profile.id}
              onClick={() => onActivate(profile.id)}
              left={(
                <>
                  <Label className="min-w-0 truncate text-sm font-medium text-ink">
                    {profile.name}
                  </Label>
                  <If cond={profile.default}>
                    <Description className="min-w-0 text-xs text-muted">
                      <Ellipsis>{t('profiles.default_desc')}</Ellipsis>
                    </Description>
                  </If>
                </>
              )}
              right={(
                <>
                  <Checkbox
                    isSelected={profile.active}
                    isDisabled={busy}
                    aria-label={profile.name}
                    className="shrink-0"
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                    </Checkbox.Content>
                  </Checkbox>
                  <Chip
                    className="rounded-md"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation()
                      setActiveView({ profile: profile.id })
                    }}
                  >
                    {t('backup.manage')}
                  </Chip>
                  <Chip
                    className={`rounded-md${busy ? ' cursor-not-allowed opacity-50' : ' cursor-pointer'}`}
                    color="accent"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (!busy)
                        openCloneDialog(profile)
                    }}
                  >
                    {t('profiles.clone')}
                  </Chip>
                  <If cond={!profile.default}>
                    <Chip
                      className={`rounded-md${busy ? ' cursor-not-allowed opacity-50' : ' cursor-pointer'}`}
                      variant="primary"
                      color="danger"
                      size="sm"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (!busy)
                          onRemove(profile.id)
                      }}
                    >
                      {t('profiles.remove')}
                    </Chip>
                  </If>
                </>
              )}
            />
          ))}
          {/* 新建档案：内联输入 or 触发入口 */}
          <If
            cond={!creating}
            else={(
              <div className="flex items-center gap-2 px-1">
                <Input
                  autoFocus
                  variant="secondary"
                  className="h-8 flex-1 rounded-md"
                  placeholder={t('profiles.name_placeholder')}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      commitCreate()
                  }}
                />
                <Button size="sm" variant="tertiary" className="h-8 rounded-md" onPress={cancelCreate}>
                  {t('profiles.create_cancel')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  className="h-8 rounded-md"
                  isDisabled={!name.trim() || busy}
                  onPress={commitCreate}
                >
                  {t('profiles.create_confirm')}
                </Button>
              </div>
            )}
          >
            <Button
              onClick={startCreate}
              variant="tertiary"
              className="flex w-full rounded-md"
              isDisabled={busy}
            >
              <Plus className="size-3.5" />
              <span>{t('profiles.new_profile')}</span>
            </Button>
          </If>
        </div>
      </Panel.Loadable>
      {dialogHolder}

      {/* 克隆档案：命名对话框（创建型，accent；可编辑建议名称） */}
      <AlertDialog
        isOpen={cloning !== null}
        onOpenChange={(open) => {
          if (!open)
            setCloning(null)
        }}
      >
        <AlertDialog.Backdrop>
          <AlertDialog.Container>
            <AlertDialog.Dialog className="sm:max-w-[400px]">
              <AlertDialog.CloseTrigger />
              <AlertDialog.Header>
                <AlertDialog.Icon status="accent" />
                <AlertDialog.Heading>{t('profiles.clone_dialog_title')}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="text-xs text-muted">
                  {cloning && t('profiles.clone_dialog_desc', { name: cloning.sourceName })}
                </p>
                <Input
                  autoFocus
                  variant="secondary"
                  className="h-8 rounded-md w-full my-2"
                  placeholder={t('profiles.clone_name_placeholder')}
                  value={cloneName}
                  onChange={e => setCloneName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      commitClone()
                  }}
                />
                {cloning && (
                  <p className="text-xs text-muted">
                    {t('profiles.clone_default_hint', { name: suggestCloneName(cloning.sourceId) })}
                  </p>
                )}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button className="rounded-md" variant="tertiary" onPress={() => setCloning(null)}>
                  {t('profiles.clone_cancel')}
                </Button>
                <Button
                  className="rounded-md"
                  variant="primary"
                  isDisabled={!cloneName.trim() || busy}
                  onPress={commitClone}
                >
                  {busy ? t('profiles.clone_cloning') : t('profiles.clone_confirm')}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </div>
  )
}
