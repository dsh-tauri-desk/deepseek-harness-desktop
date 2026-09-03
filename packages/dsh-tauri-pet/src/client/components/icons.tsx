import type { ReactElement, ReactNode, SVGProps } from 'react'

/**
 * components/icons.tsx — gravity-ui 图标（Gravity UI 风格，currentColor）。
 *
 * 与 dsh-tauri-panel-scheduler / dsh-tauri-panel-extension 一致：图标是纯 SVG
 * path，取自 gravity-ui 上游并固化进源码，免去 client bundle 对额外运行时包的
 * 解析（@gravity-ui/icons 未在 dsh-tauri-tsdown 的 `dshClientInline` 内联列表
 * 中，直接 import 会在 ModuleLoader 查表失败）。
 * 图标源: https://github.com/gravity-ui/icons/blob/main/svgs/<name>.svg
 * License: MIT, © 2022 YANDEX LLC.
 */

export type IconProps = SVGProps<SVGSVGElement> & { size?: number }

/** 共享 16×16 描边外壳；`size` 控制渲染尺寸，其余 SVG 属性透传。 */
function IconShell({ size = 16, children, ...rest }: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg {...rest} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {children}
    </svg>
  )
}

/**
 * Gravity UI Icons `plus.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/plus.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconPlus(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" fillRule="evenodd" d="M8 1.75a.75.75 0 0 1 .75.75v4.75h4.75a.75.75 0 0 1 0 1.5H8.75v4.75a.75.75 0 0 1-1.5 0V8.75H2.5a.75.75 0 0 1 0-1.5h4.75V2.5A.75.75 0 0 1 8 1.75" clipRule="evenodd" />
    </IconShell>
  )
}

/**
 * Gravity UI Icons `arrow-down-to-line.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/arrow-down-to-line.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconImport(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" fillRule="evenodd" d="M8.53 11.78a.75.75 0 0 1-1.06 0l-2.5-2.5a.75.75 0 0 1 1.06-1.06l1.22 1.22V1.75a.75.75 0 0 1 1.5 0v7.69l1.22-1.22a.75.75 0 1 1 1.06 1.06zM1.75 13.5a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5z" clipRule="evenodd" />
    </IconShell>
  )
}
