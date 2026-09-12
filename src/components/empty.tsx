import type { ReactNode } from 'react'
import { cn } from 'tailwind-variants'

/**
 * 空态 / 内联提示：带边框的浅底小字提示条。
 * 统一为 ui/config/core「本地核心缺失提示」的样式（p-3、左对齐），
 * 供各配置面板的空列表与补充提示共用。
 */
export interface EmptyProps {
  children?: ReactNode
  className?: string
}

export function Empty({ children, className }: EmptyProps) {
  return (
    <p className={cn('rounded-md border border-line bg-panel2/40 p-3 text-xs text-muted', className)}>
      {children}
    </p>
  )
}
