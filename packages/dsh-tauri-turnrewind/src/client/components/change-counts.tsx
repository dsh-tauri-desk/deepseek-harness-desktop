import type { ReactElement } from 'react'
import type { ChangeCountsProps } from './change-counts.types'

/**
 * 绿色 `+N` / 红色 `-M` 计数（官方 deliverables 行同款配色）。
 *
 * 视觉是分开着色的两个 span，同时由调用方把 `formatCounts` 的结果放进 `title`，
 * 保证读屏与悬浮提示拿到的是同一条「+N -M」文本。
 */
export function ChangeCounts({ insertions, deletions, binary, binaryLabel }: ChangeCountsProps): ReactElement {
  if (binary)
    return <span className="dshp-turnrewind-counts"><span className="dshp-turnrewind-counts__binary">{binaryLabel}</span></span>
  return (
    <span className="dshp-turnrewind-counts">
      <span className="dshp-turnrewind-counts__add">{`+${insertions ?? 0}`}</span>
      <span className="dshp-turnrewind-counts__del">{`-${deletions ?? 0}`}</span>
    </span>
  )
}
