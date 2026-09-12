import type { ReactNode } from 'react'
import { cn } from 'tailwind-variants'

/**
 * 信息键值行（term|value）：两侧对齐的「项目名 + 值」行。
 * 供 ui/config/debug 的运行时信息与「关于 / 检查更新」对话框共用，
 * 值默认用等宽字体（版本号/路径等类代码内容）。
 */
export interface InfoProps {
  /** 左侧项名 */
  term: string
  /** 右侧值（可为节点；无则显示 '-' 由调用方决定） */
  children?: ReactNode
  className?: string
}

export function Info({ term, children, className }: InfoProps) {
  return (
    <div className={cn('flex items-center justify-between gap-2 text-xs py-0.5', className)}>
      <span className="shrink-0 text-muted font-medium">{term}</span>
      <span className="min-w-0 break-all text-right font-mono text-ink">{children}</span>
    </div>
  )
}
