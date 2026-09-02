import { CircleExclamation } from '@gravity-ui/icons'
import { Button, Chip, Label, Spinner, Tooltip } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { tv } from 'tailwind-variants'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { toast } from '@/utils/toast'
import { useDshPlugins } from '../hooks/use-dsh-plugins'
import { Ellipsis as TextEllipsis } from './ellipsis'
import { Empty } from './empty'
import { Item } from './item'
import { Modal } from './modal'
import { PanelHeader } from './panel-header'
import { PanelState } from './panel-state'

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
export function ConfigPlugin() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { plugins, loading, error, disablePlugin, enablePlugin } = useDshPlugins()
  const { preinstall } = useStore(store.harness)

  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })

  /** 行内操作进行中状态：id + 操作类型（update/remove/disable/enable/snapshot/restore/delete-snapshot），保证单例运行 */
  const [busy, setBusy] = useState<{ id: string, action: 'update' | 'remove' | 'disable' | 'enable' | 'snapshot' | 'restore' | 'delete-snapshot' } | null>(null)

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
    mutationFn: (id: string) => enablePlugin(id),
    onSuccess: (_data, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      void queryClient.invalidateQueries({ queryKey: ['plugins'] })
      toast(t('plugins.enable_toast', { name }), {})
    },
    onError: (err, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
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

  async function onUpgrade(id: string) {
    if (busy)
      return
    setBusy({ id, action: 'update' })
    try {
      await upgrade.mutateAsync(id)
    }
    catch {
      // 错误提示已由 mutation 的 onError 处理
    }
    finally {
      setBusy(null)
      // 插件操作会停掉运行中的服务（即使失败也已被后端停止），这里统一拉起服务并
      // 同步前端运行状态，避免留下「服务已死但界面仍显示运行中」的过期状态。
      void store.harness.restart()
    }
  }

  async function onRemove(id: string, name: string) {
    if (busy)
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
    catch {
      return
    }
    setBusy({ id, action: 'remove' })
    try {
      await remove.mutateAsync(id)
    }
    catch {
      // 错误提示已由 mutation 的 onError 处理
    }
    finally {
      setBusy(null)
      // 同上：卸载后统一拉起服务，避免服务被后端停止后前端状态过期。
      void store.harness.restart()
    }
  }

  async function onDisable(id: string) {
    if (busy)
      return
    // 禁用是可逆操作（保留包体，启用即可恢复），无需确认对话框。
    setBusy({ id, action: 'disable' })
    try {
      await disable.mutateAsync(id)
    }
    catch {
      // 错误提示已由 mutation 的 onError 处理
    }
    finally {
      setBusy(null)
      // 禁用后统一拉起服务，使新的 bundles 列表生效。
      void store.harness.restart()
    }
  }

  async function onEnable(id: string) {
    if (busy)
      return
    setBusy({ id, action: 'enable' })
    try {
      await enable.mutateAsync(id)
    }
    catch {
      // 错误提示已由 mutation 的 onError 处理
    }
    finally {
      setBusy(null)
      // 启用后统一拉起服务，使新的 bundles 列表生效。
      void store.harness.restart()
    }
  }

  async function onSnapshot(id: string, name: string, hasSnapshot: boolean) {
    if (busy)
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
      catch {
        return
      }
    }
    setBusy({ id, action: 'snapshot' })
    try {
      await snapshot.mutateAsync(id)
    }
    catch {
      // 错误提示已由 mutation 的 onError 处理
    }
    finally {
      setBusy(null)
    }
  }

  async function onRestore(id: string, name: string) {
    if (busy)
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
    catch {
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
    catch {
      // 错误提示已由 mutation 的 onError 处理
    }
    finally {
      setBusy(null)
    }
  }

  async function onDeleteSnapshot(id: string, name: string) {
    if (busy)
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
    catch {
      return
    }
    setBusy({ id, action: 'delete-snapshot' })
    try {
      await deleteSnapshot.mutateAsync(id)
    }
    catch {
      // 错误提示已由 mutation 的 onError 处理
    }
    finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <PanelHeader
        className="sticky top-0 bg-canvas z-10 pb-3"
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
        description={t('plugins.panel_tooltip')}
      />

      {/* 加载 / 失败 / 空态 */}
      <PanelState loading={loading} error={error}>
        <If
          cond={plugins.length > 0}
          else={(
            <Empty>{t('plugins.empty')}</Empty>
          )}
        >
          <div className="flex flex-col gap-4">
            {plugins.sort(a => a.internal ? -1 : 1).map(plugin => (
              <Item
                key={plugin.id}
                left={(
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
                      <Label className="min-w-0 truncate text-sm font-medium text-ink">
                        {plugin.name}
                      </Label>
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
                    </div>
                    <If cond={plugin.description !== ''}>
                      <TextEllipsis lineClamp={2} className="text-xs text-muted">
                        {plugin.description}
                      </TextEllipsis>
                    </If>
                  </div>
                )}
                right={(
                  <>
                    {/* 升级入口仅在确有更新（updateAvailable）或插件异常（error，修复入口）时显示；
                        与文档 P1「对 dshmarket 点击升级」一致，且不会常驻——up-to-date 插件不显示升级按钮 */}
                    <If cond={plugin.updateAvailable || plugin.error != null}>
                      <Chip
                        className={actionChip({ busy: !!busy })}
                        variant="primary"
                        color="accent"
                        size="sm"
                        onClick={() => onUpgrade(plugin.id)}
                      >
                        <span className="flex items-center gap-1">
                          <If cond={busy?.id === plugin.id && busy.action === 'update'} then={<Spinner size="sm" color="current" />} />
                          {t('plugins.upgrade')}
                          {/* TODO: hash 会超出长度 */}
                          {/* <If cond={plugin.latestVersion != null && plugin.error == null}>
                            <span className="font-mono text-[10px] opacity-80">{plugin.latestVersion}</span>
                          </If> */}
                        </span>
                      </Chip>
                    </If>
                    <If cond={!plugin.internal}>
                      <If cond={plugin.disabled}>
                        <Chip
                          className={actionChip({ busy: !!busy })}
                          variant="primary"
                          color="accent"
                          size="sm"
                          onClick={() => onEnable(plugin.id)}
                        >
                          <span className="flex items-center gap-1">
                            <If cond={busy?.id === plugin.id && busy.action === 'enable'} then={<Spinner size="sm" color="current" />} />
                            {t('plugins.enable')}
                          </span>
                        </Chip>
                      </If>
                      <If cond={!plugin.disabled}>
                        <Chip
                          className={actionChip({ busy: !!busy })}
                          size="sm"
                          onClick={() => onDisable(plugin.id)}
                        >
                          <span className="flex items-center gap-1">
                            <If cond={busy?.id === plugin.id && busy.action === 'disable'} then={<Spinner size="sm" color="current" />} />
                            {t('plugins.disable')}
                          </span>
                        </Chip>
                      </If>
                      {/* 单插件快照：快照始终可用（已存在时覆盖确认）；还原/删除快照仅在
                          存在快照时显示。还原会停服务，还原后 toast 提示重启（issue #303） */}
                      <Chip
                        className={actionChip({ busy: !!busy })}
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
                          className={actionChip({ busy: !!busy })}
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
                          className={actionChip({ busy: !!busy })}
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
                        className={actionChip({ busy: !!busy })}
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
              />
            ))}
          </div>
        </If>
      </PanelState>

      {dialogHolder}
    </div>
  )
}
