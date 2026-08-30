import type { RenameProfileValue } from './rename-profile-dialog'
import { Ellipsis as EllipsisIcon, Plus } from '@gravity-ui/icons'
import { AlertDialog, Button, Checkbox, Description, Dropdown, Input, Label } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'

import { store } from '@/store'
import { formatBytes } from '@/utils/format'
import { toast } from '@/utils/toast'
import { useDshProfiles } from '../hooks/use-dsh-profiles'
import { Ellipsis } from './ellipsis'
import { Item } from './item'
import { Modal } from './modal'
import { PanelHeader } from './panel-header'
import { PanelState } from './panel-state'
import { ProfileBackupSection } from './profile-backup-section'
import { RenameProfileDialog } from './rename-profile-dialog'

export function ConfigProfile() {
  /**
   * 「档案」面板：展示 & 切换 dsh 配置档案，支持新建/克隆/重命名/删除/立即备份，
   * 下方为「档案备份」设置区与备份历史（见 ProfileBackupSection）。
   *
   * 数据来自 `useDshProfiles`（`get_profiles` 查询 + `setting_updated` 事件刷新）：
   * 档案 = `$DSH_HOME/profiles/<id>` 目录，与官方 dsh CLI 的 profile 语义一致；
   * 桌面端把「当前档案」持久化在 store（`active_profile`），服务启动与插件管理
   * 都以它为准。切换档案写入后自动重启服务（`store.harness.restart()`）；
   * 切换和重启期间禁用档案操作。
   */
  const { profiles, loading, error, createProfile, cloneProfile, renameProfile, activateProfile, removeProfile, backupNow, busy: profilesBusy } = useDshProfiles()
  // 切换/重启期间（含后端正在停止服务）一并禁用档案操作
  const { busyAction } = useStore(store.harness)
  const busy = profilesBusy || busyAction !== null

  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })
  const [renameDialog, openRenameDialog] = useOverlay(RenameProfileDialog, { type: 'holder' })

  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const activeProfile = profiles.find(p => p.active)

  async function activate(id: string) {
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
    catch {
      return
    }
    try {
      // 切换只保存目标 ID；生效依赖服务重启，这里直接走既有重启流程
      await activateProfile(id)
      toast(t('profiles.activate_toast', { name: target.name }), {
        variant: 'accent',
        description: t('profiles.activate_restarting'),
        timeout: 10_000,
      })
      await store.harness.restart()
    }
    catch (err) {
      console.error('[ConfigProfile] activate failed:', err)
      toast(t('profiles.activate_failed', { name: target.name }), { variant: 'danger' })
    }
  }

  // 克隆命名对话框状态（AlertDialog + 组件内 state：输入始终可编辑，
  // 避免 overlastic holder 不刷新 props 的输入冻结问题，见 rename 对话框）
  const [cloning, setCloning] = useState<{ sourceId: string, sourceName: string } | null>(null)
  const [cloneName, setCloneName] = useState('')
  // 对话框 JSX 的 children 表达式在元素创建时求值（不受 If cond 控制），
  // cloning 为 null 时不能解引用，这里用 ?? '' 兜底保证求值安全
  const cloneSourceName = cloning?.sourceName ?? ''
  const cloneSourceId = cloning?.sourceId ?? ''

  /** 推导下一个未占用的自动递增名称（仅作为对话框建议；后端才是权威） */
  function suggestCloneName(base: string): string {
    const taken = new Set(profiles.map(p => p.id))
    for (let n = 1; n <= 999; n++) {
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
    if (!cloning || busy)
      return
    const trimmed = cloneName.trim()
    if (!trimmed) {
      toast(t('profiles.clone_empty'), {})
      return
    }
    // 快照源档案信息：await 期间用户可能关闭对话框（cloning 变 null），
    // 失败 toast 不能读已置空的 state
    const sourceId = cloning.sourceId
    const sourceName = cloning.sourceName
    try {
      const cloned = await cloneProfile(sourceId, trimmed)
      setCloning(null)
      setCloneName('')
      // 克隆成功后列表已刷新出新档案，UI 本身就有变化，只提示克隆结果
      toast(t('profiles.clone_toast', { name: cloned.name }), {})
    }
    catch (err) {
      console.error('[ConfigProfile] clone failed:', err)
      // 对话框保持打开：用户可改名重试
      toast(t('profiles.clone_failed', { name: sourceName }), { variant: 'danger' })
    }
  }

  async function backup(id: string) {
    const target = profiles.find(p => p.id === id)
    if (!target || busy)
      return
    try {
      const backupRow = await backupNow(id)
      toast(t('profiles.backup_toast', { name: target.name }), {
        variant: 'accent',
        description: t('profiles.backup_size_hint', { size: formatBytes(backupRow.sizeBytes) }),
      })
    }
    catch (err) {
      console.error('[ConfigProfile] backup failed:', err)
      toast(t('profiles.backup_failed', { name: target.name }), { variant: 'danger' })
    }
  }

  async function rename(id: string) {
    const target = profiles.find(p => p.id === id)
    if (!target || busy)
      return
    // 独立对话框组件：状态在内部，输入始终可编辑，确认返回 { name, description }
    let result: RenameProfileValue
    try {
      result = await openRenameDialog({
        currentName: target.name,
        currentDescription: target.description,
      })
    }
    catch {
      return
    }
    try {
      await renameProfile(id, result.name, result.description)
      toast(t('profiles.rename_toast', { name: result.name }), {})
    }
    catch (err) {
      console.error('[ConfigProfile] rename failed:', err)
      toast(t('profiles.rename_failed'), { variant: 'danger' })
    }
  }

  function startCreate() {
    setCreating(true)
    setName('')
  }

  function cancelCreate() {
    setCreating(false)
    setName('')
  }

  async function commitCreate() {
    const trimmed = name.trim()
    if (!trimmed)
      return
    try {
      // 创建成功后列表已刷新出新档案，UI 本身就有变化，不再弹成功 toast
      await createProfile(trimmed)
      setCreating(false)
      setName('')
    }
    catch (err) {
      console.error('[ConfigProfile] create failed:', err)
      toast(t('profiles.create_failed'), { variant: 'danger' })
    }
  }

  async function remove(id: string) {
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
    catch {
      return
    }
    try {
      // 删除成功后列表已移除该档案，UI 本身就有变化，不再弹成功 toast
      await removeProfile(id)
    }
    catch (err) {
      console.error('[ConfigProfile] remove failed:', err)
      toast(t('profiles.remove_failed'), { variant: 'danger' })
    }
  }

  return (
    <div className="space-y-3">
      <PanelHeader title={t('profiles.title')} description={t('profiles.tooltip')} />

      {/* 加载 / 失败 / 列表 */}
      <PanelState loading={loading} error={error}>
        <div className="flex flex-col gap-4">
          {profiles.map(profile => (
            <Item
              key={profile.id}
              onClick={() => activate(profile.id)}
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
                  <If cond={!profile.default && profile.description}>
                    <Description className="min-w-0 text-xs text-muted">
                      <Ellipsis>{profile.description}</Ellipsis>
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
                  {/* 每行操作：立即备份 / 克隆 / 重命名 / 删除（默认与当前档案不可删） */}
                  <Dropdown>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 min-w-0 rounded-md px-1"
                      isDisabled={busy}
                      aria-label={t('profiles.actions', { name: profile.name })}
                      onClick={(event) => {
                        event.stopPropagation()
                      }}
                    >
                      <EllipsisIcon className="size-4" />
                    </Button>
                    <Dropdown.Popover className="rounded-md w-5!">
                      <Dropdown.Menu>
                        <Dropdown.Item
                          className="rounded-md"
                          id={`backup-${profile.id}`}
                          textValue={t('profiles.backup_now')}
                          onAction={() => backup(profile.id)}
                        >
                          <Label>{t('profiles.backup_now')}</Label>
                        </Dropdown.Item>
                        <Dropdown.Item
                          className="rounded-md"
                          id={`clone-${profile.id}`}
                          textValue={t('profiles.clone')}
                          onAction={() => openCloneDialog(profile)}
                        >
                          <Label>{t('profiles.clone')}</Label>
                        </Dropdown.Item>
                        <Dropdown.Item
                          className="rounded-md"
                          id={`rename-${profile.id}`}
                          textValue={t('profiles.rename')}
                          onAction={() => rename(profile.id)}
                        >
                          <Label>{t('profiles.rename')}</Label>
                        </Dropdown.Item>
                        <If cond={!profile.default && !profile.active}>
                          <Dropdown.Item
                            className="rounded-md"
                            id={`remove-${profile.id}`}
                            textValue={t('profiles.remove')}
                            onAction={() => remove(profile.id)}
                          >
                            <Label className="text-danger">{t('profiles.remove')}</Label>
                          </Dropdown.Item>
                        </If>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
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
      </PanelState>

      {/* 档案备份：自动备份设置 + 备份历史 */}
      <If cond={activeProfile != null}>
        <ProfileBackupSection activeProfile={activeProfile!} />
      </If>
      {dialogHolder}
      {renameDialog}

      {/* 克隆档案：命名对话框（预填建议名；后端校验规范化与冲突） */}
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
                {/* JSX children 表达式在元素创建时即求值（不受 If cond 控制），
                    cloning 为 null 时不能解引用；?? '' 兜底保证求值安全 */}
                <If cond={cloning != null}>
                  <p className="text-xs text-muted">
                    {t('profiles.clone_dialog_desc', { name: cloneSourceName })}
                  </p>
                </If>
                <Input
                  autoFocus
                  variant="secondary"
                  className="h-8 rounded-md"
                  placeholder={t('profiles.clone_name_placeholder')}
                  value={cloneName}
                  onChange={e => setCloneName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      void commitClone()
                  }}
                />
                <If cond={cloning != null}>
                  <p className="text-xs text-muted">
                    {t('profiles.clone_default_hint', { name: suggestCloneName(cloneSourceId) })}
                  </p>
                </If>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button className="rounded-md" variant="tertiary" onPress={() => setCloning(null)}>
                  {t('profiles.clone_cancel')}
                </Button>
                <Button
                  className="rounded-md"
                  variant="primary"
                  isDisabled={!cloneName.trim() || busy}
                  onPress={() => void commitClone()}
                >
                  {t('profiles.clone_confirm')}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </div>
  )
}
