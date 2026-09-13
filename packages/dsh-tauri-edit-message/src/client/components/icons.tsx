/**
 * client/components/icons.tsx — 图标（React 组件）。
 *
 * 形状取自 `@gravity-ui/icons` 上游（`viewBox="0 0 16 16"`、`fill="currentColor"`、
 * 单条 `path`），颜色完全交给 CSS 的 `currentColor` 与主题变量，亮色 / 暗色自动适配。
 *
 * 这里不 import `@gravity-ui/icons`：客户端 bundle 的模块表只认平台种子（react）与已
 * 链接模块，引用不存在的 specifier 会让 loader 整棵树失败（界面白屏）。
 */

import type { ReactElement } from 'react'

/** Gravity UI Pencil（编辑）。 */
const PENCIL_PATH = 'M11.423 1A3.577 3.577 0 0 1 15 4.577c0 .27-.108.53-.3.722l-.528.529-1.971 1.971-5.059 5.059a3 3 0 0 1-1.533.82l-2.638.528a1 1 0 0 1-1.177-1.177l.528-2.638a3 3 0 0 1 .82-1.533l5.059-5.059 2.5-2.5c.191-.191.451-.299.722-.299m-2.31 4.009-4.91 4.91a1.5 1.5 0 0 0-.41.766l-.38 1.903 1.902-.38a1.5 1.5 0 0 0 .767-.41l4.91-4.91a2.08 2.08 0 0 0-1.88-1.88m3.098.658a3.6 3.6 0 0 0-1.878-1.879l1.28-1.28c.995.09 1.788.884 1.878 1.88z'

/** 图标外壳：统一 16×16、`fill="none"`、`currentColor` 着色。 */
function Icon({ children }: { children: ReactElement }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

/** Pencil：编辑消息。 */
export function PencilIcon(): ReactElement {
  return (
    <Icon>
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={PENCIL_PATH} />
    </Icon>
  )
}
