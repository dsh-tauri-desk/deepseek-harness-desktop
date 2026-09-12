/* eslint-disable react-refresh/only-export-components -- 复合组件导出（与 HeroUI 的 Modal.* / Select.* 同款写法） */
import type { ReactNode } from 'react'
import { Spinner, Typography } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { Logs } from './logs'

/** 进度面板最多展示的日志行数 */
const LOG_LIMIT = 5

/**
 * 面板（`Panel`）复合组件：设置面板共用的三块结构。
 *
 * - `Panel.Header`  标题 + 说明（+ 右侧动作位）
 * - `Panel.Loadable` 列表三态（加载中 / 加载失败 / 正常内容）
 * - `Panel.Progress` 进度条 + 日志面板
 *
 * 三者原本是三个独立文件（panel-header / panel-loadable / panel-progress），
 * 统一收敛到本文件并用点号导出，调用方只需 import 一个 `Panel`。
 */
export interface PanelHeaderProps {
  title: string | ReactNode
  description: string
  className?: string
  action?: ReactNode
}

/** 配置面板头部：标题 + 说明；className 用于叠加 sticky / 背景等定位类。 */
function Header({ title, description, className, action }: PanelHeaderProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-3">
        {typeof title === 'string' ? <Typography type="h4">{title}</Typography> : title}
        {action}
      </div>
      <Typography color="muted" type="body-sm">{description}</Typography>
    </div>
  )
}

export interface PanelLoadableProps {
  loading: boolean
  error: string
  children?: ReactNode
}

/**
 * 列表三态（加载中 / 加载失败 / 正常内容）。
 * 加载中带 spinner，失败态复用 plugins.error 文案；error 为空且非 loading 时渲染 children。
 */
function Loadable({ loading, error, children }: PanelLoadableProps) {
  const { t } = useTranslation()
  return (
    <If
      cond={!loading && error === ''}
      else={(
        <If
          cond={loading}
          else={(
            <p className="rounded-md border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
              {t('plugins.error')}
              ：
              {error}
            </p>
          )}
        >
          <div className="flex items-center justify-center gap-2 p-4 text-xs text-muted">
            <Spinner size="sm" color="current" />
            {t('plugins.loading')}
          </div>
        </If>
      )}
    >
      {children}
    </If>
  )
}

export interface PanelProgressProps {
  /** 进度百分比（0-100）；不传则不渲染进度条 */
  percentage?: number
  /** 日志行；不传则不渲染日志面板（空数组渲染"等待日志"占位） */
  logs?: readonly string[]
}

/**
 * 安装/下载进度面板：进度条 + 日志面板。
 * 供首次安装（setup）与核心版本下载对话框共用：两处都要展示
 * `install-progress` 事件驱动的百分比与日志流。
 */
function Progress({ percentage, logs }: PanelProgressProps) {
  const hasLogs = logs != null
  const showPanel = hasLogs || percentage != null

  if (!showPanel) {
    return null
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {percentage != null && (
        <div className="flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-panel2" role="progressbar" aria-valuenow={Math.round(percentage)}>
            <div className="h-full bg-gradient-to-r from-accent to-accent2 transition-[width] duration-150" style={{ width: `${Math.min(percentage, 100)}%` }} />
          </div>
          <span className="min-w-[44px] text-right text-[13px] font-semibold tabular-nums text-accent2">
            {Math.round(percentage)}
            %
          </span>
        </div>
      )}
      {hasLogs && (
        <Logs logs={logs ?? []} limit={LOG_LIMIT} bodyClassName="max-h-[184px]" />
      )}
    </div>
  )
}

export const Panel = { Header, Loadable, Progress }
