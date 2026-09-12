import type { AppSettingUpdate } from '@/store/modules/setting'
import { ArrowRotateRight, ArrowUpRightFromSquare, ChevronRight, Copy, Folder, Power, TrashBin } from '@gravity-ui/icons'
import { Button, Chip, Description, Input, Link, ListBox, Select, Spinner, Surface, Switch } from '@heroui/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { Info } from '@/components/info'
import { queryKeys } from '@/config/query-keys'
import { useListen } from '@/hooks/use-listen'
import { store } from '@/store'
import { ConfigCloseAction } from '@/ui/config/components/close-action'
import { ConfigLaunchOnLogin } from '@/ui/config/components/launch-on-login'
import { useCoreBreakingConfirm } from '@/ui/config/hooks/use-core-breaking-confirm'
import { writeClipboardText } from '@/utils/clipboard'
import { toast } from '@/utils/toast'

const ZOOM_OPTIONS = Array.from({ length: 16 }, (_, index) => Number((0.5 + index * 0.1).toFixed(1)))

export interface RuntimeInfo {
  app_version: string
  dsh_version: string | null
  node_version: string
  service_url: string
  data_dir: string
  log_path: string
  platform: string
  arch: string
}

export interface CliLinkStatus {
  enabled: boolean
  shim_exists: boolean
  path_registered: boolean
  user_dsh_preserved: boolean
  bin_dir: string
  shim_path: string
}

export function ConfigDebug() {
  const { t, i18n } = useTranslation()
  const { serviceRunning, busyAction } = useStore(store.harness)
  const { updateInfo } = useStore(store.harnessUpdater)
  const { holder: coreBreakingHolder, confirmCoreBreaking } = useCoreBreakingConfirm()

  // 端口编辑态：用户尚未输入时为 undefined，展示值始终以 store 中已保存的端口为准。
  // 初值不写入 state（避免渲染期副作用），用户一旦输入即以输入值为准。
  const [portInput, setPortInput] = useState<number>()

  const { data: info, refetch: refreshInfo } = useQuery({
    queryKey: queryKeys.info,
    queryFn: () => invoke<RuntimeInfo>('get_runtime_info'),
  })

  // 设置变更（如端口避让后服务地址变化）会让运行时信息过期，重拉一次
  useListen('setting_updated', () => {
    void refreshInfo()
  })

  const { port: savedPort, zoom_factor: zoomFactor } = useStore(store.setting)
  const port = portInput ?? savedPort

  const { data: cliStatus, refetch: refreshCliStatus } = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => invoke<CliLinkStatus>('get_cli_link_status'),
  })

  const { data: logs, refetch: refreshLogs } = useQuery({
    queryKey: queryKeys.logs,
    queryFn: () => invoke<string>('read_service_logs'),
    refetchInterval: 2000,
  })

  async function copyLogs() {
    try {
      // 成功/失败提示由 writeClipboardText 统一给出，这里只记录日志
      await writeClipboardText(logs || '', t('messages.logs_copied'))
    }
    catch (err) {
      console.error('[ConfigDebug] copy logs failed:', err)
    }
  }

  /** 「存在新版本」：直接展示更新提示；破坏性更改确认推迟到点击「立即更新」时 */
  function handleShowNewVersion() {
    store.harnessUpdater.showToast(() => handleUpdate())
  }

  /** 点击「立即更新」：目标版本高于 rc.2 时先弹破坏性更改确认，取消则中止更新 */
  async function handleUpdate() {
    const info = store.harnessUpdater.updateInfo
    if (!info || !(await confirmCoreBreaking(info.tag)))
      return
    await store.harnessUpdater.handleUpdate()
  }

  const { mutate: onClearLogs } = useMutation({
    mutationFn: async () => {
      await invoke('clear_service_logs')
      await refreshLogs()
      toast(t('messages.logs_cleared'))
    },
    onError: (err: unknown) => {
      console.error('[ConfigDebug] clear logs failed:', err)
      toast(t('messages.logs_clear_failed'), { variant: 'danger' })
    },
  })

  const { mutate: onToggleCliLink } = useMutation({
    mutationFn: async (enabled: boolean) => {
      // 命令会先建/删 shim 与 PATH 再落盘，前端只改 store 不会产生这些副作用
      await invoke('update_app_config', { cliLinkEnabled: enabled } satisfies AppSettingUpdate)
      await refreshCliStatus()
    },
    onError: (err: unknown) => {
      console.error('[ConfigDebug] toggle cli link failed:', err)
      toast(t('messages.cli_link_failed'), { variant: 'danger' })
    },
  })

  /**
   * 缩放真值写进 setting store（persist 写入的 `setting` 键与 Rust 共用同一份 `.store.dat`），
   *  WebView 上的应用由 `iframe.tsx` 的 `useZoomFactor` 完成，因此这里没有失败分支。
   */
  function onSetZoom(zoomFactor: number) {
    store.setting.zoom_factor = zoomFactor
  }

  const { mutate: onCopyServiceUrl } = useMutation({
    mutationFn: async () => {
      await invoke('copy_service_url')
      toast(t('messages.copy_success'))
    },
    onError: (err: unknown) => {
      console.error('[ConfigDebug] copy url failed:', err)
      toast(t('messages.copy_failed'), { variant: 'danger' })
    },
  })

  const { mutate: onSavePort } = useMutation({
    mutationFn: async (port: number) => {
      // 保存前校验：必须是 1–65535 的整数（输入框可能被清空成 0 / 浮点 / NaN）
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT_INVALID')
      }
      // 后端会同时记录 manual_port（端口避让后回落到用户选择，issue #91）
      await invoke('update_app_config', { port } satisfies AppSettingUpdate)
      const key = toast(t('messages.port_changed'), {
        variant: 'accent',
        description: t('messages.port_restart_hint'),
        timeout: 10_000,
        actionProps: {
          children: t('app.restart'),
          onPress: () => {
            store.harness.restart()
            toast.close(key)
          },
        },
      })
    },
    onError: (err: unknown) => {
      console.error('[ConfigDebug] save port failed:', err)
      if (String(err).includes('PORT_INVALID')) {
        toast(t('messages.port_invalid'), { variant: 'danger' })
      }
      else {
        toast(t('messages.port_save_failed'), { variant: 'danger' })
      }
    },
  })

  const { mutate: onRevealDataDir } = useMutation({
    mutationFn: () => invoke('reveal_data_dir'),
    onError: (err: unknown) => {
      console.error('[ConfigDebug] reveal data dir failed:', err)
      toast(t('messages.reveal_dir_failed'), { variant: 'danger' })
    },
  })

  return (
    <div className="space-y-3">
      {coreBreakingHolder}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t('ui.connection_status')}
          </span>
          <Chip
            size="sm"
            variant="soft"
            color={serviceRunning ? 'success' : 'danger'}
            className="font-medium"
          >
            {serviceRunning ? t('ui.running') : t('ui.stopped')}
          </Chip>
        </div>
        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <Input
              readOnly
              variant="secondary"
              value={info?.service_url ?? '-'}
              aria-label={t('ui.service_url')}
              className="font-mono text-xs flex-1 rounded-md"
            />
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              className="rounded-md"

              onPress={() => onCopyServiceUrl()}
              aria-label={t('buttons.copy')}
            >
              <Copy className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-md"
              isIconOnly
              onPress={store.harness.openBrowser}
              isDisabled={busyAction !== null}
              aria-label={t('app.open_browser')}
            >
              <If cond={busyAction === 'openBrowser'} then={<Spinner size="sm" color="current" />} else={<ArrowUpRightFromSquare className="size-3.5" />} />
            </Button>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <If cond={serviceRunning}>
          <Button
            size="sm"
            variant="tertiary"
            className="flex-1 rounded-md"
            onPress={store.harness.restart}
            isDisabled={busyAction !== null}
          >
            <If cond={busyAction === 'restart'} then={<Spinner size="sm" color="current" />} else={<ArrowRotateRight className="size-3.5" />} />
            {t('app.restart')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            className="flex-1 rounded-md"
            onPress={store.harness.shutdown}
            isDisabled={busyAction !== null}
          >
            <If cond={busyAction === 'shutdown'} then={<Spinner size="sm" color="current" />} else={<Power className="size-3.5" />} />
            {t('app.shutdown')}
          </Button>
        </If>
      </div>
      <div className="border-t border-line/30" />
      <div>
        <div className="space-y-1">
          <Info term={t('ui.current_version')}>{info?.app_version ?? '-'}</Info>
          <Info term={t('ui.dsh_version')}>
            <span>{info?.dsh_version ?? '-'}</span>
            <If cond={updateInfo}>
              <Link className="ml-2 text-[10px] text-accent" onClick={handleShowNewVersion}>
                {t('menu.new_version')}
                <ChevronRight className="scale-75" />
              </Link>
            </If>

          </Info>
          <Info term={t('ui.node_version')}>{info?.node_version ? `v${info.node_version}` : '-'}</Info>
          <Info term={t('ui.platform')}>
            {info ? `${info.platform} / ${info.arch}` : '-'}
          </Info>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="shrink-0 min-w-[30%] text-muted font-medium">{t('ui.data_dir')}</span>
            <span className="min-w-0 flex items-center gap-1">
              <span className="truncate font-mono text-[11px] text-muted/80" title={info?.data_dir ?? '-'}>
                {info?.data_dir ?? '-'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                isIconOnly
                className="size-6 min-w-6 rounded-md"
                aria-label={t('app.reveal_dir')}
                onPress={() => onRevealDataDir()}
              >
                <Folder className="size-3.5" />
              </Button>
            </span>
          </div>
        </div>
      </div>
      <div className="border-t border-line/30" />
      <div className="space-y-1.5">
        <ConfigLaunchOnLogin />
        <ConfigCloseAction />
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink">{t('ui.cli_link_enabled')}</span>
            <Switch
              isSelected={cliStatus?.enabled ?? false}
              onChange={onToggleCliLink}
              aria-label={t('ui.cli_link_enabled')}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
          <If cond={cliStatus != null}>
            <div className="flex flex-col">
              <If
                cond={!cliStatus?.user_dsh_preserved}
                else={(
                  <Description className="text-[10px] text-muted/70">
                    {t('ui.cli_link_user_dsh_preserved')}
                  </Description>
                )}
              >
                <Description className="text-[10px] text-muted/70">{cliStatus?.bin_dir}</Description>
                <Description className="text-[10px] text-muted/70">
                  {t('ui.cli_link_hint')}
                </Description>
              </If>
            </div>
          </If>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-ink">{t('ui.port')}</span>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              variant="secondary"
              value={String(port)}
              onChange={e => setPortInput(Number(e.target.value))}
              className="w-24 h-8 rounded-md [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              aria-label={t('ui.port')}
            />
            <Button
              size="sm"
              variant="primary"
              className="rounded-md h-8"
              onPress={() => onSavePort(port)}
            >
              {t('buttons.save')}
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-ink">{t('ui.language')}</span>
          <Select
            variant="secondary"
            selectedKey={i18n.language}
            onSelectionChange={key => i18n.changeLanguage(String(key))}
            className="w-[80px]"
            aria-label={t('ui.language')}
          >
            <Select.Trigger className="rounded-md min-h-8! h-8 py-0 items-center">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="rounded-md">
              <ListBox>
                <ListBox.Item className="rounded-md min-h-8!" id="zh-CN" textValue={t('ui.languages.zh')}>{t('ui.languages.zh')}</ListBox.Item>
                <ListBox.Item className="rounded-md min-h-8!" id="en-US" textValue={t('ui.languages.en')}>{t('ui.languages.en')}</ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-ink">{t('ui.zoom')}</span>
          <Select
            variant="secondary"
            selectedKey={String(zoomFactor)}
            onSelectionChange={key => onSetZoom(Number(key))}
            className="w-[80px]"
            aria-label={t('ui.zoom')}
          >
            <Select.Trigger className="rounded-md min-h-8! h-8 py-0 items-center">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="rounded-md">
              <ListBox>
                {ZOOM_OPTIONS.map(zoomFactor => (
                  <ListBox.Item
                    className="rounded-md min-h-8!"
                    id={String(zoomFactor)}
                    key={zoomFactor}
                    textValue={`${Math.round(zoomFactor * 100)}%`}
                  >
                    {`${Math.round(zoomFactor * 100)}%`}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      </div>

      <div className="border-t border-line/30" />

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-ink">{t('ui.logs')}</span>
          <div className="flex gap-1">
            <Button
              isIconOnly
              size="sm"
              className="rounded-md size-6"
              variant="ghost"
              onPress={() => { void copyLogs() }}
            >
              <Copy className="scale-80" />
            </Button>
            <Button
              isIconOnly
              size="sm"
              className="rounded-md size-6"
              variant="ghost"
              onPress={() => onClearLogs()}
            >
              <TrashBin className="scale-80" />
            </Button>
          </div>
        </div>
        <Surface className="bg-default rounded-md p-2 min-h-[140px] max-h-[180px] font-mono text-[11px] w-full leading-relaxed overflow-auto">
          {logs || t('ui.no_logs')}
        </Surface>
      </div>
    </div>
  )
}
