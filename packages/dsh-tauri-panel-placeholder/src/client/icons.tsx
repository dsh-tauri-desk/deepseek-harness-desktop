import type { ReactElement } from 'react'
import type { IconProps } from './types'

/**
 * icons.tsx — 自绘内联 SVG 图标（Gravity 风格描边，currentColor）。
 * 不依赖 @deepseek-ai/dsh-client-ui-primitives 的类型/运行时（loader 模块表
 * 虽提供该模块，但自绘零外部表面、跨部署更稳）。
 */

export function IconPlaceholder({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24"><path fill="currentColor" d="M13 12.6V9q0-.425-.288-.712T12 8t-.712.288T11 9v3.975q0 .2.075.388t.225.337l2.8 2.8q.275.275.7.275t.7-.275t.275-.7t-.275-.7zm-4.512 8.688q-1.638-.713-2.85-1.925t-1.925-2.85T3 13t.713-3.512t1.924-2.85t2.85-1.925T12 4t3.513.713t2.85 1.925t1.925 2.85T21 13t-.712 3.513t-1.925 2.85t-2.85 1.925T12 22t-3.512-.712M2.05 7.3q-.275-.275-.275-.7t.275-.7L4.9 3.05q.275-.275.7-.275t.7.275t.275.7t-.275.7L3.45 7.3q-.275.275-.7.275t-.7-.275m19.9 0q-.275.275-.7.275t-.7-.275L17.7 4.45q-.275-.275-.275-.7t.275-.7t.7-.275t.7.275l2.85 2.85q.275.275.275.7t-.275.7M12 20q2.925 0 4.963-2.037T19 13t-2.037-4.962T12 6T7.038 8.038T5 13t2.038 4.963T12 20" /></svg>
  )
}
