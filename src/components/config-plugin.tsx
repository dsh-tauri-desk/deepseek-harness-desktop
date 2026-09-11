import type { DshPlugin } from '../hooks/use-dsh-plugins'
import type { PluginBatchAction } from './plugin-batch-dialog'
import { CircleExclamation } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Label, Link, Spinner, Tooltip } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { tv } from 'tailwind-variants'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'
import { useDshPlugins } from '../hooks/use-dsh-plugins'
import { Ellipsis as TextEllipsis } from './ellipsis'
import { Empty } from './empty'
import { Item } from './item'
import { Modal } from './modal'
import { PanelHeader } from './panel-header'
import { PanelState } from './panel-state'
import { PluginBatchDialog } from './plugin-batch-dialog'

/**
 * 操作 chip 的样式变体：busy 时禁止点击并降低透明度，否则可点击。
 * 统一各操作 chip 的 busy 样式，避免内联三元重复。
 */
const actionChip = tv({
  base: 'rounded-md',
  variants: {
    busy: {
      true: 'cursor-not-allowed opacity-50',
      false: 'cursor-pointer',
    },
  },
  defaultVariants: {
    busy: false,
  },
})

/**
 * 「插件」面板：展示已安装插件，作为「插件出问题时」的卸载/升级入口。
 *
 * - 数据来自 `useDshPlugins`（`get_dsh_plugins` 查询 + `dsh-plugins-updated`
 *   实时事件，react-query 缓存同步）。
 * - 升级 `update_dsh_plugin` / 卸载 `remove_dsh_plugin` 已接入后端
 *   （`dsh plugin --profile <当前档案> update|remove <id>`，进程输出经
 *   `preinstall-log` 事件实时推送）。
 * - 「异常」标记：插件带 `error` 字段（安装/升级/卸载失败或页面运行期上报）
 *   时显示 danger 图标按钮，Tooltip 展示错误详情，行内可直接升级/卸载修复。
 */
export interface ConfigPluginProps {
  onBatchRunning?: (running: boolean) => void
  onBatchClose?: () => void
}

export function ConfigPlugin(props: ConfigPluginProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { plugins, loading, error, disablePlugin, enablePlugin } = useDshPlugins()
  const { preinstall } = useStore(store.harness)

  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })
  const [batchDialogHolder, openBatchDialog] = useOverlay(PluginBatchDialog, { type: 'holder' })

  /** 行内操作进行中状态：id + 操作类型（update/remove/disable/enable/snapshot/restore/delete-snapshot），保证单例运行 */
  const [busy, setBusy] = useState<{ id: string, action: 'update' | 'remove' | 'disable' | 'enable' | 'snapshot' | 'restore' | 'delete-snapshot' } | null>(null)
  const [batchAction, setBatchAction] = useState<PluginBatchAction | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [showBuiltInPlugins, setShowBuiltInPlugins] = useState(false)

  const upgrade = useMutation({
    mutationFn: (id: string) => invoke<void>('update_dsh_plugin', { id }),
    onSuccess: (_data, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      // 失效插件列表查询：dsh-plugins-updated 事件在停服务重启场景下可能丢失
      // （插件操作会停止运行中的服务），必须显式重拉以确保列表落盘后刷新。
      void queryClient.invalidateQueries({ queryKey: ['plugins'] })
      toast(t('plugins.updated_toast', { name }), {})
    },
    onError: (err, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      console.error('[ConfigPlugin] upgrade failed:', err)
      toast(t('plugins.upgrade_failed', { name }), {})
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => invoke<void>('remove_dsh_plugin', { id }),
    onSuccess: (_data, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      // 同上：卸载成功后显式重拉插件列表，避免事件推送丢失导致列表未更新。
      void queryClient.invalidateQueries({ queryKey: ['plugins'] })
      toast(t('plugins.removed_toast', { name }), {})
    },
    onError: (err, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      console.error('[ConfigPlugin] remove failed:', err)
      toast(t('plugins.remove_failed', { name }), {})
    },
  })
  const disable = useMutation({
    mutationFn: (id: string) => disablePlugin(id),
    onSuccess: (_data, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      void queryClient.invalidateQueries({ queryKey: ['plugins'] })
      toast(t('plugins.disable_toast', { name }), {})
    },
    onError: (err, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      console.error('[ConfigPlugin] disable failed:', err)
      toast(t('plugins.disable_failed', { name }), {})
    },
  })
  const enable = useMutation({
    mutationFn: (args: { id: string, clearConfigOverride: boolean }) =>
      enablePlugin(args.id, args.clearConfigOverride),
    onSuccess: (_data, args) => {
      const name = plugins.find(p => p.id === args.id)?.name ?? args.id
      void queryClient.invalidateQueries({ queryKey: ['plugins'] })
      toast(t('plugins.enable_toast', { name }), {})
    },
    onError: (err, args) => {
      const name = plugins.find(p => p.id === args.id)?.name ?? args.id
      console.error('[ConfigPlugin] enable failed:', err)
      toast(t('plugins.enable_failed', { name }), {})
    },
  })
  const snapshot = useMutation({
    mutationFn: (id: string) => invoke<void>('snapshot_plugin', { id }),
    onSuccess: (_data, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      void queryClient.invalidateQueries({ queryKey: ['plugins'] })
      toast(t('plugins.snapshot_toast', { name }), {})
    },
    onError: (err, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      console.error('[ConfigPlugin] snapshot failed:', err)
      toast(t('plugins.snapshot_failed', { name }), {})
    },
  })
  const restore = useMutation({
    mutationFn: (id: string) => invoke<void>('restore_plugin', { id }),
    onSuccess: (_data, _id) => {
      // 还原后快照仍在（覆盖式不删快照），插件版本回到快照态：重拉列表。
      void queryClient.invalidateQueries({ queryKey: ['plugins'] })
    },
    onError: (err, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      console.error('[ConfigPlugin] restore failed:', err)
      toast(t('plugins.restore_failed', { name }), {})
    },
  })
  const deleteSnapshot = useMutation({
    mutationFn: (id: string) => invoke<void>('delete_plugin_backup', { id }),
    onSuccess: (_data, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      void queryClient.invalidateQueries({ queryKey: ['plugins'] })
      toast(t('plugins.snapshot_deleted_toast', { name }), {})
    },
    onError: (err, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      console.error('[ConfigPlugin] delete snapshot failed:', err)
      toast(t('plugins.snapshot_delete_failed', { name }), {})
    },
  })

  async function runBatchAction(action: PluginBatchAction, plugin: DshPlugin) {
    switch (action) {
      case 'disable':
        await disablePlugin(plugin.id)
        return
      case 'enable':
        await enablePlugin(plugin.id, plugin.patchDisabled)
        return
      case 'remove':
        await invoke<void>('remove_dsh_plugin', { id: plugin.id })
        return
      case 'update':
        await invoke<void>('update_dsh_plugin', { id: plugin.id })
    }
  }

  function canBatchAction(plugin: DshPlugin, action: PluginBatchAction) {
    switch (action) {
      case 'disable':
        return !plugin.internal && !plugin.patchDisabled && !plugin.disabled
      case 'enable':
        return plugin.patchDisabled || (!plugin.internal && plugin.disabled)
      case 'remove':
        return !plugin.internal
      case 'update':
        return plugin.updateAvailable || plugin.error != null
    }
  }

  function selectedPluginsFor(action: PluginBatchAction) {
    return plugins.filter(plugin => !plugin.internal && selectedIds.has(plugin.id) && canBatchAction(plugin, action))
  }

  function togglePluginSelection(id: string, checked: boolean) {
    if (plugins.some(plugin => plugin.id === id && plugin.internal))
      return

    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (checked)
        next.add(id)
      else
        next.delete(id)
      return next
    })
  }

  function toggleAllSelection(checked: boolean) {
    if (checked)
      setSelectedIds(new Set(plugins.filter(plugin => !plugin.internal).map(plugin => plugin.id)))
    else
      setSelectedIds(new Set())
  }

  async function onBatchAction(action: PluginBatchAction) {
    if (busy || batchAction != null)
      return
    const targets = selectedPluginsFor(action)
    if (targets.length === 0)
      return

    if (action === 'remove') {
      try {
        await openDialog({
          status: 'danger',
          title: t('plugins.batch_remove_confirm_title'),
          description: (
            <p>{t('plugins.batch_remove_confirm_desc', { count: targets.length })}</p>
          ),
          confirmText: t('plugins.uninstall'),
        })
      }
      catch (error) {
        silence(error, 'plugin batch remove: dialog cancelled')
        return
      }
    }

    if (action === 'enable' && targets.some(plugin => plugin.patchDisabled)) {
      try {
        await openDialog({
          status: 'warning',
          title: t('plugins.batch_enable_override_confirm_title'),
          description: (
            <p>{t('plugins.batch_enable_override_confirm_desc', { count: targets.length })}</p>
          ),
          confirmText: t('plugins.enable_override_confirm'),
        })
      }
      catch (error) {
        silence(error, 'plugin batch enable: dialog cancelled')
        return
      }
    }

    setBatchAction(action)
    props.onBatchRunning?.(true)
    try {
      await openBatchDialog({
        action,
        plugins: targets,
        runAction: plugin => runBatchAction(action, plugin),
        completeBatch: async (restartNow) => {
          if (restartNow)
            await store.harness.restart()
          await queryClient.invalidateQueries({ queryKey: ['plugins'] })
        },
      })
      setSelectedIds(new Set())
    }
    catch (error) {
      silence(error, 'plugin batch: dialog failed')
    }
    finally {
      setBatchAction(null)
      props.onBatchRunning?.(false)
      props.onBatchClose?.()
    }
  }

  async function onUpgrade(id: string) {
    if (busy || batchAction != null)
      return
    setBusy({ id, action: 'update' })
    try {
      await upgrade.mutateAsync(id)
    }
    catch (e) {
      silence(e, 'plugin upgrade: error already shown by mutation onError')
    }
    finally {
      setBusy(null)
      // 插件操作会停掉运行中的服务（即使失败也已被后端停止），这里统一拉起服务并
      // 同步前端运行状态，避免留下「服务已死但界面仍显示运行中」的过期状态。
      void store.harness.restart()
    }
  }

  async function onRemove(id: string, name: string) {
    if (busy || batchAction != null)
      return
    try {
      await openDialog({
        status: 'danger',
        title: t('plugins.remove_confirm_title'),
        description: (
          <p>
            {t('plugins.remove_confirm_desc', { name })}
          </p>
        ),
        confirmText: t('plugins.uninstall'),
      })
    }
    catch (e) {
      silence(e, 'plugin remove: dialog cancelled')
      return
    }
    setBusy({ id, action: 'remove' })
    try {
      await remove.mutateAsync(id)
    }
    catch (e) {
      silence(e, 'plugin remove: error already shown by mutation onError')
    }
    finally {
      setBusy(null)
      // 同上：卸载后统一拉起服务，避免服务被后端停止后前端状态过期。
      void store.harness.restart()
    }
  }

  async function onDisable(id: string) {
    if (busy || batchAction != null)
      return
    // 禁用是可逆操作（保留包体，启用即可恢复），无需确认对话框。
    setBusy({ id, action: 'disable' })
    try {
      await disable.mutateAsync(id)
    }
    catch (e) {
      silence(e, 'plugin disable: error already shown by mutation onError')
    }
    finally {
      setBusy(null)
      // 禁用后统一拉起服务，使新的 bundles 列表生效。
      void store.harness.restart()
    }
  }

  async function onEnable(id: string, clearConfigOverride = false) {
    if (busy || batchAction != null)
      return
    // 配置覆盖禁用：启用会修改用户的 cordis.patch.yml（仅移除该插件的禁用覆盖，
    // 其余配置条目保留），属于改写用户配置文件的操作，必须先明确确认。
    if (clearConfigOverride) {
      const name = plugins.find(p => p.id === id)?.name ?? id
      try {
        await openDialog({
          status: 'warning',
          title: t('plugins.enable_override_confirm_title'),
          description: (
            <p>
              {t('plugins.enable_override_confirm_desc', { name })}
            </p>
          ),
          confirmText: t('plugins.enable_override_confirm'),
        })
      }
      catch (e) {
        silence(e, 'plugin enable: config override dialog cancelled')
        return
      }
    }
    setBusy({ id, action: 'enable' })
    try {
      await enable.mutateAsync({ id, clearConfigOverride })
    }
    catch (e) {
      silence(e, 'plugin enable: error already shown by mutation onError')
    }
    finally {
      setBusy(null)
      // 启用后统一拉起服务，使新的 bundles 列表生效。
      void store.harness.restart()
    }
  }

  async function onSnapshot(id: string, name: string, hasSnapshot: boolean) {
    if (busy || batchAction != null)
      return
    // 已存在快照：覆盖式，先确认再覆盖（快照语义 = 覆盖当前状态）。
    if (hasSnapshot) {
      try {
        await openDialog({
          status: 'warning',
          title: t('plugins.snapshot_overwrite_title'),
          description: (
            <p>
              {t('plugins.snapshot_overwrite_desc', { name })}
            </p>
          ),
          confirmText: t('plugins.snapshot_overwrite_confirm'),
        })
      }
      catch (e) {
        silence(e, 'plugin snapshot: dialog cancelled')
        return
      }
    }
    setBusy({ id, action: 'snapshot' })
    try {
      await snapshot.mutateAsync(id)
    }
    catch (e) {
      silence(e, 'plugin snapshot: error already shown by mutation onError')
    }
    finally {
      setBusy(null)
    }
  }

  async function onRestore(id: string, name: string) {
    if (busy || batchAction != null)
      return
    try {
      await openDialog({
        status: 'warning',
        title: t('plugins.restore_confirm_title'),
        description: (
          <p>
            {t('plugins.restore_confirm_desc', { name })}
          </p>
        ),
        confirmText: t('plugins.restore'),
      })
    }
    catch (e) {
      silence(e, 'plugin restore: dialog cancelled')
      return
    }
    setBusy({ id, action: 'restore' })
    try {
      await restore.mutateAsync(id)
      // 还原期间后端已停止服务：复用 config-backup 的「重启服务」toast 交互
      const key = toast(t('plugins.restore_restart_hint', { name }), {
        variant: 'accent',
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
    catch (e) {
      silence(e, 'plugin restore: error already shown by mutation onError')
    }
    finally {
      setBusy(null)
    }
  }

  async function onDeleteSnapshot(id: string, name: string) {
    if (busy || batchAction != null)
      return
    try {
      await openDialog({
        status: 'danger',
        title: t('plugins.snapshot_delete_title'),
        description: (
          <p>
            {t('plugins.snapshot_delete_desc', { name })}
          </p>
        ),
        confirmText: t('plugins.snapshot_delete_confirm'),
      })
    }
    catch (e) {
      silence(e, 'plugin delete-snapshot: dialog cancelled')
      return
    }
    setBusy({ id, action: 'delete-snapshot' })
    try {
      await deleteSnapshot.mutateAsync(id)
    }
    catch (e) {
      silence(e, 'plugin delete-snapshot: error already shown by mutation onError')
    }
    finally {
      setBusy(null)
    }
  }

  // 与后端 watch::parse_plugins 保持一致：随启动加载的插件在前，其余按 id 字典序。
  const sortedPlugins = [...plugins].sort((a, b) => {
    if (a.bundled !== b.bundled)
      return a.bundled ? -1 : 1
    if (a.id < b.id)
      return -1
    if (a.id > b.id)
      return 1
    return 0
  })
  const selectablePlugins = plugins.filter(plugin => !plugin.internal)
  const displayedPlugins = showBuiltInPlugins
    ? sortedPlugins
    : sortedPlugins.filter(plugin => !plugin.internal)
  const selectedCount = selectablePlugins.filter(plugin => selectedIds.has(plugin.id)).length
  const allSelected = selectablePlugins.length > 0 && selectablePlugins.every(plugin => selectedIds.has(plugin.id))
  const disableTargets = selectedPluginsFor('disable')
  const enableTargets = selectedPluginsFor('enable')
  const removeTargets = selectedPluginsFor('remove')
  const updateTargets = selectedPluginsFor('update')
  const controlsDisabled = busy != null || batchAction != null
  const batchToolbar = (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-panel2 px-3 py-2">
      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox
          isSelected={allSelected}
          isDisabled={controlsDisabled || selectablePlugins.length === 0}
          onChange={toggleAllSelection}
          aria-label={t('plugins.batch_select_all')}
          className="shrink-0"
        >
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
          </Checkbox.Content>
        </Checkbox>
        <span className="text-xs text-muted">{t('plugins.batch_selected', { count: selectedCount })}</span>
      </label>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="tertiary"
          className="rounded-md"
          isDisabled={controlsDisabled || disableTargets.length === 0}
          onPress={() => onBatchAction('disable')}
        >
          {t('plugins.disable')}
        </Button>
        <Button
          size="sm"
          variant="tertiary"
          className="rounded-md"
          isDisabled={controlsDisabled || enableTargets.length === 0}
          onPress={() => onBatchAction('enable')}
        >
          {t('plugins.enable')}
        </Button>
        <Button
          size="sm"
          variant="tertiary"
          className="rounded-md"
          isDisabled={controlsDisabled || removeTargets.length === 0}
          onPress={() => onBatchAction('remove')}
        >
          {t('plugins.uninstall')}
        </Button>
        <Button
          size="sm"
          variant="tertiary"
          className="rounded-md"
          isDisabled={controlsDisabled || updateTargets.length === 0}
          onPress={() => onBatchAction('update')}
        >
          {t('plugins.upgrade')}
        </Button>
      </div>
    </div>
  )

  return (
    <div>
      <div className="sticky top-0 z-10 bg-canvas pb-3">
        <PanelHeader
          className="bg-canvas"
          title={t('plugins.title')}
          action={(
            <Tooltip delay={0}>
              <Button
                size="sm"
                variant="primary"
                className="rounded-md"
                onPress={store.harness.openPreinstall}
                isDisabled={preinstall.installing}
              >
                {t('preinstall.open_preset')}
              </Button>
              <Tooltip.Content>
                <p>{t('preinstall.settings_hint')}</p>
              </Tooltip.Content>
            </Tooltip>
          )}
          description={(
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{t('plugins.panel_tooltip')}</span>
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <Checkbox
                  isSelected={showBuiltInPlugins}
                  isDisabled={controlsDisabled}
                  onChange={setShowBuiltInPlugins}
                  aria-label={t('plugins.show_builtin')}
                  className="shrink-0"
                >
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                  </Checkbox.Content>
                </Checkbox>
                <span>{t('plugins.show_builtin')}</span>
              </label>
            </span>
          )}
        />
        <If cond={selectablePlugins.length > 0}>
          {batchToolbar}
        </If>
      </div>

      {/* 加载 / 失败 / 空态 */}
      <PanelState loading={loading} error={error}>
        <If
          cond={displayedPlugins.length > 0}
          else={(
            <Empty>{plugins.length > 0 ? t('plugins.no_visible') : t('plugins.empty')}</Empty>
          )}
        >
          <div className="flex flex-col gap-4">
            {displayedPlugins.map(plugin => (
              <Item
                key={plugin.id}
                left={(
                  <>
                    <Checkbox
                      isSelected={selectedIds.has(plugin.id)}
                      isDisabled={controlsDisabled || plugin.internal}
                      onChange={checked => togglePluginSelection(plugin.id, checked)}
                      aria-label={t('plugins.batch_select_plugin', { name: plugin.name })}
                      className="shrink-0"
                    >
                      <Checkbox.Content>
                        <Checkbox.Control>
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                      </Checkbox.Content>
                    </Checkbox>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1">
                        <If cond={plugin.error != null}>
                          <Tooltip delay={0}>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              className="size-6 shrink-0 rounded-md text-danger"
                              aria-label={t('plugins.abnormal_tooltip')}
                            >
                              <CircleExclamation />
                            </Button>
                            <Tooltip.Content className="max-w-[320px]">
                              <div className="space-y-1">
                                <p className="text-xs font-medium">
                                  {t('plugins.abnormal_desc', { name: plugin.name })}
                                </p>
                                <p className="whitespace-pre-wrap break-all font-mono text-[11px] opacity-80">
                                  {plugin.error?.message}
                                </p>
                              </div>
                            </Tooltip.Content>
                          </Tooltip>
                        </If>
                        {plugin.repo_url !== ''
                          ? (
                              <Link
                                className="min-w-0 truncate text-sm font-medium text-accent hover:underline"
                                onClick={() => {
                                  void invoke('open_external_url', { url: plugin.repo_url })
                                }}
                              >
                                {plugin.name}
                              </Link>
                            )
                          : (
                              <Label className="min-w-0 truncate text-sm font-medium text-ink">
                                {plugin.name}
                              </Label>
                            )}
                        <If cond={plugin.version !== ''}>
                          <code className="shrink-0 rounded bg-default px-1.5 py-0.5 font-mono text-[10px] text-muted">
                            {plugin.version}
                          </code>
                        </If>
                        <If cond={!plugin.internal && plugin.recommended}>
                          <Chip size="sm" variant="soft" color="success" className="shrink-0 font-medium">
                            {t('plugins.preset')}
                          </Chip>
                        </If>
                        <If cond={plugin.internal}>
                          <code className="shrink-0 rounded bg-default px-1.5 py-0.5 font-mono text-[10px] text-muted">
                            {t('plugins.builtin')}
                          </code>
                        </If>
                        <If cond={plugin.disabled}>
                          <Chip size="sm" variant="soft" color="default">
                            {t('plugins.disabled_badge')}
                          </Chip>
                        </If>
                        {/* 配置覆盖禁用：展示在 cordis.patch.yml 中被显式禁用的真实状态
                          （内置插件同样标注，issue #399：Scheduler/Pet 行此前只有「内置」） */}
                        <If cond={plugin.patchDisabled}>
                          <Chip size="sm" variant="soft" color="warning">
                            {t('plugins.patch_disabled_badge')}
                          </Chip>
                        </If>
                      </div>
                      <If cond={plugin.description !== ''}>
                        <TextEllipsis lineClamp={2} className="text-xs text-muted">
                          {plugin.description}
                        </TextEllipsis>
                      </If>
                    </div>
                  </>
                )}
                right={(
                  <>
                    {/* 升级入口仅在确有更新（updateAvailable）或插件异常（error，修复入口）时显示；
                        与文档 P1「对 dshmarket 点击升级」一致，且不会常驻——up-to-date 插件不显示升级按钮 */}
                    <If cond={plugin.updateAvailable || plugin.error != null}>
                      <Chip
                        className={actionChip({ busy: controlsDisabled })}
                        variant="primary"
                        color="accent"
                        size="sm"
                        onClick={() => onUpgrade(plugin.id)}
                      >
                        <span className="flex items-center gap-1">
                          <If cond={busy?.id === plugin.id && busy.action === 'update'} then={<Spinner size="sm" color="current" />} />
                          {t('plugins.upgrade')}
                          <If cond={plugin.latestVersion != null && plugin.error == null}>
                            <span className="font-mono text-[10px] opacity-80 max-w-[80px] truncate">
                              {plugin.latestVersion && plugin.latestVersion.length >= 40 ? `${plugin.latestVersion.slice(0, 8)}…` : plugin.latestVersion}
                            </span>
                          </If>
                        </span>
                      </Chip>
                    </If>
                    {/* 启用入口：配置覆盖禁用（含内置插件）或桌面禁用清单 → 可启用。
                        配置覆盖禁用时点击会先弹确认框，确认后后端才移除该覆盖 */}
                    <If cond={plugin.patchDisabled || (!plugin.internal && plugin.disabled)}>
                      <Chip
                        className={actionChip({ busy: controlsDisabled })}
                        variant="primary"
                        color="accent"
                        size="sm"
                        onClick={() => onEnable(plugin.id, plugin.patchDisabled)}
                      >
                        <span className="flex items-center gap-1">
                          <If cond={busy?.id === plugin.id && busy.action === 'enable'} then={<Spinner size="sm" color="current" />} />
                          {t('plugins.enable')}
                        </span>
                      </Chip>
                    </If>
                    <If cond={!plugin.internal && !plugin.patchDisabled && !plugin.disabled}>
                      <Chip
                        className={actionChip({ busy: controlsDisabled })}
                        size="sm"
                        onClick={() => onDisable(plugin.id)}
                      >
                        <span className="flex items-center gap-1">
                          <If cond={busy?.id === plugin.id && busy.action === 'disable'} then={<Spinner size="sm" color="current" />} />
                          {t('plugins.disable')}
                        </span>
                      </Chip>
                    </If>
                    <If cond={!plugin.internal}>
                      {/* 单插件快照：快照始终可用（已存在时覆盖确认）；还原/删除快照仅在
                          存在快照时显示。还原会停服务，还原后 toast 提示重启（issue #303） */}
                      <Chip
                        className={actionChip({ busy: controlsDisabled })}
                        variant="primary"
                        color="accent"
                        size="sm"
                        onClick={() => onSnapshot(plugin.id, plugin.name, plugin.hasSnapshot)}
                      >
                        <span className="flex items-center gap-1">
                          <If cond={busy?.id === plugin.id && busy.action === 'snapshot'} then={<Spinner size="sm" color="current" />} />
                          {t('plugins.snapshot')}
                        </span>
                      </Chip>
                      <If cond={plugin.hasSnapshot}>
                        <Chip
                          className={actionChip({ busy: controlsDisabled })}
                          variant="primary"
                          color="accent"
                          size="sm"
                          onClick={() => onRestore(plugin.id, plugin.name)}
                        >
                          <span className="flex items-center gap-1">
                            <If cond={busy?.id === plugin.id && busy.action === 'restore'} then={<Spinner size="sm" color="current" />} />
                            {t('plugins.restore')}
                          </span>
                        </Chip>
                        <Chip
                          className={actionChip({ busy: controlsDisabled })}
                          size="sm"
                          onClick={() => onDeleteSnapshot(plugin.id, plugin.name)}
                        >
                          <span className="flex items-center gap-1">
                            <If cond={busy?.id === plugin.id && busy.action === 'delete-snapshot'} then={<Spinner size="sm" color="current" />} />
                            {t('plugins.delete_snapshot')}
                          </span>
                        </Chip>
                      </If>
                      <Chip
                        className={actionChip({ busy: controlsDisabled })}
                        variant="primary"
                        color="danger"
                        size="sm"
                        onClick={() => onRemove(plugin.id, plugin.name)}
                      >
                        <span className="flex items-center gap-1">
                          <If cond={busy?.id === plugin.id && busy.action === 'remove'} then={<Spinner size="sm" color="current" />} />
                          {t('plugins.uninstall')}
                        </span>
                      </Chip>
                    </If>
                  </>
                )}
                footer={(
                  <If cond={plugin.dshCompatible === false}>
                    <div className="mt-2 flex items-start gap-1.5 text-xs text-warning">
                      <CircleExclamation className="mt-0.5 size-3.5 shrink-0" />
                      <span>{t('plugins.incompatible_hint', { support: plugin.dshVersionSupport })}</span>
                    </div>
                  </If>
                )}
              />
            ))}
          </div>
        </If>
      </PanelState>

      {dialogHolder}
      {batchDialogHolder}
    </div>
  )
}
