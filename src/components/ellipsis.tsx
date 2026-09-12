import type { ReactNode } from 'react'
import type { VariantProps } from 'tailwind-variants'
import { Tooltip } from '@heroui/react'
import { useElementOverflow } from '@reause/core'
import { useRef, useState } from 'react'
import { cn, tv } from 'tailwind-variants'

export interface EllipsisProps {
  lineClamp?: number
  tooltip?: ReactNode
  children?: ReactNode
  className?: string
  tooltipClassName?: string
  forceTooltip?: boolean
}

const ellipsis = tv({
  slots: {
    container: '',
    tooltip: '',
  },
})

/**
 * 单行/多行截断文本：仅在真的溢出时才弹 Tooltip。
 *
 * 溢出判定交给 reause `useElementOverflow`（ResizeObserver + MutationObserver 观测
 * 容器与子元素的尺寸/内容变化），不再自建 ref + hover 时手量：
 * - 多行（`lineClamp`）看纵向溢出（scrollHeight > offsetHeight）；
 * - 单行（truncate）看横向溢出（scrollWidth > offsetWidth）。
 *
 * `forceTooltip` 跳过溢出判定，始终允许弹出（内容异步渲染等观测不到的场合）。
 */
export function Ellipsis(props: EllipsisProps & VariantProps<typeof ellipsis>) {
  const [open, setOpen] = useState(false)
  const { container, tooltip } = ellipsis(props)
  const triggerRef = useRef<HTMLDivElement>(null)
  const { isXOverflowed, isYOverflowed } = useElementOverflow(triggerRef, { observeMutation: true })
  const overflowed = props.lineClamp === undefined ? isXOverflowed : isYOverflowed

  function onOpenChange(next: boolean) {
    if (!overflowed && !props.forceTooltip)
      return

    setOpen(next)
  }

  return (
    <Tooltip isOpen={open} onOpenChange={onOpenChange}>
      <div
        ref={triggerRef}
        className={cn(
          props.lineClamp === undefined ? 'truncate' : 'line-clamp-[var(--line-clamp)] [display:-webkit-inline-box]!',
          container({ className: props.className }),
        )}
        style={
          {
            '--line-clamp': props.lineClamp,
          } as React.CSSProperties
        }
      >
        {props.lineClamp ? props.children : <span>{props.children}</span>}
      </div>
      <Tooltip.Content className={cn(tooltip(), props.tooltipClassName)}>
        {props.tooltip || props.children}
      </Tooltip.Content>
    </Tooltip>
  )
}
