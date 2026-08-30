import type { ReactNode } from 'react'
import { Typography } from '@heroui/react'
import { cn } from 'tailwind-variants'

/**
 * 配置面板头部：标题 + 说明。
 * 与 config-plugin / core / profile 的「面板头」一致，
 * className 用于叠加 sticky / 背景等定位类（如 config-plugin 的 sticky 头部）。
 */
export interface PanelHeaderProps {
  title: string | ReactNode
  description: string
  className?: string
  action?: ReactNode
}

export function PanelHeader({ title, description, className, action }: PanelHeaderProps) {
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
