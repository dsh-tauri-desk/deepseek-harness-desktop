import type { ReactElement, ReactNode, SVGProps } from 'react'

/**
 * components/icons.tsx — 自绘内联 SVG 图标（Gravity UI 风格，currentColor）。
 *
 * 内联而非依赖 @gravity-ui/icons 包：图标是纯 SVG path，下载一次固化进源码，
 * 免去 client bundle 对额外运行时包的解析（与 dsh-tauri-panel-extension 一致）。
 * 图标源: https://github.com/gravity-ui/icons/blob/main/svgs/<name>.svg
 * License: MIT, © 2022 YANDEX LLC.
 */

export type IconProps = SVGProps<SVGSVGElement>

/** 共享 16×16 描边外壳；`size` 控制渲染尺寸，其余 SVG 属性透传。 */
function IconShell({ size = 16, children, ...rest }: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg {...rest} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {children}
    </svg>
  )
}

/**
 * Gravity UI Icons `calendar.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/calendar.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconSchedule(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" fillRule="evenodd" d="M5.25 5.497a.75.75 0 0 1-.75-.75V4A1.5 1.5 0 0 0 3 5.5v1h10v-1A1.5 1.5 0 0 0 11.5 4v.75a.75.75 0 0 1-1.5 0V4H6v.747a.75.75 0 0 1-.75.75M10 2.5H6v-.752a.75.75 0 1 0-1.5 0V2.5a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h7a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3v-.75a.75.75 0 0 0-1.5 0zM3 8v3.5A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5V8z" clipRule="evenodd" />
    </IconShell>
  )
}

/**
 * Gravity UI Icons `ellipsis-vertical.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/ellipsis-vertical.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconMore(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" fillRule="evenodd" d="M8 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M9.5 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0" clipRule="evenodd" />
    </IconShell>
  )
}

/**
 * Gravity UI Icons `arrows-rotate-right.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/arrows-rotate-right.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconRefresh(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" d="M13.78 2.22a.75.75 0 0 1 0 1.06l-1.03 1.03A6.25 6.25 0 1 1 8 1.75a.75.75 0 0 1 0 1.5 4.75 4.75 0 1 0 3.72 1.8l-1.19 1.2A.75.75 0 0 1 9.25 5.72V2.5a.75.75 0 0 1 .75-.75h3.25a.75.75 0 0 1 .53.47" />
    </IconShell>
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
 * Gravity UI Icons `circle-play.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/circle-play.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconPlay(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" fillRule="evenodd" d="M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0m-7.75 3.031L11 8.866a1 1 0 0 0 0-1.732L7.25 4.969a1 1 0 0 0-1.5.866v4.33a1 1 0 0 0 1.5.866" clipRule="evenodd" />
    </IconShell>
  )
}

/**
 * Gravity UI Icons `circle-pause.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/circle-pause.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconPause(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" fillRule="evenodd" d="M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14m1.75-9.75a1 1 0 0 1 1 1v3.5a1 1 0 1 1-2 0v-3.5a1 1 0 0 1 1-1m-2.5 1a1 1 0 0 0-2 0v3.5a1 1 0 1 0 2 0z" clipRule="evenodd" />
    </IconShell>
  )
}

/**
 * Gravity UI Icons `trash-bin.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/trash-bin.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconTrash(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" fillRule="evenodd" d="M9 2H7a.5.5 0 0 0-.5.5V3h3v-.5A.5.5 0 0 0 9 2m2 1v-.5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2V3H2.251a.75.75 0 0 0 0 1.5h.312l.317 7.625A3 3 0 0 0 5.878 15h4.245a3 3 0 0 0 2.997-2.875l.318-7.625h.312a.75.75 0 0 0 0-1.5zm.936 1.5H4.064l.315 7.562A1.5 1.5 0 0 0 5.878 13.5h4.245a1.5 1.5 0 0 0 1.498-1.438zm-6.186 2v5a.75.75 0 0 0 1.5 0v-5a.75.75 0 0 0-1.5 0m3.75-.75a.75.75 0 0 1 .75.75v5a.75.75 0 0 1-1.5 0v-5a.75.75 0 0 1 .75-.75" clipRule="evenodd" />
    </IconShell>
  )
}

/**
 * Gravity UI Icons `comment-plus.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/comment-plus.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconChat(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" fillRule="evenodd" d="m4.772 11.795.071-.851-.695-.496C3.156 9.743 2.5 8.648 2.5 7c0-1.563.59-2.62 1.48-3.323C4.913 2.94 6.305 2.5 8 2.5s3.087.44 4.02 1.177c.89.702 1.48 1.76 1.48 3.323s-.59 2.62-1.48 3.323C11.087 11.06 9.695 11.5 8 11.5q-.108 0-.213-.002l-.59-.013-.44.391-1.77 1.572a.204.204 0 0 1-.338-.17zm2.981 1.202L5.984 14.57a1.704 1.704 0 0 1-2.83-1.415l.123-1.484C1.877 10.674 1 9.117 1 7c0-4 3.134-6 7-6s7 2 7 6-3.134 6-7 6q-.124 0-.247-.003M8.75 5a.75.75 0 0 0-1.5 0v1.25H6a.75.75 0 0 0 0 1.5h1.25V9a.75.75 0 0 0 1.5 0V7.75H10a.75.75 0 0 0 0-1.5H8.75z" clipRule="evenodd" />
    </IconShell>
  )
}

/**
 * Gravity UI Icons `magnifier.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/magnifier.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconSearch(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" fillRule="evenodd" d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0m-.82 4.74a6 6 0 1 1 1.06-1.06l2.79 2.79a.75.75 0 1 1-1.06 1.06z" clipRule="evenodd" />
    </IconShell>
  )
}

/**
 * Gravity UI Icons `calendar.svg`（推荐列表条目图标）。
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/calendar.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconCalendar(props: IconProps): ReactElement {
  return (
    <IconShell {...props}>
      <path fill="currentColor" fillRule="evenodd" d="M5.25 5.497a.75.75 0 0 1-.75-.75V4A1.5 1.5 0 0 0 3 5.5v1h10v-1A1.5 1.5 0 0 0 11.5 4v.75a.75.75 0 0 1-1.5 0V4H6v.747a.75.75 0 0 1-.75.75M10 2.5H6v-.752a.75.75 0 1 0-1.5 0V2.5a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h7a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3v-.75a.75.75 0 0 0-1.5 0zM3 8v3.5A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5V8z" clipRule="evenodd" />
    </IconShell>
  )
}

/**
 * Gravity UI Icons `clock.svg`（字符串版本，供 register/session-icons.ts 的 DOM
 * 补丁以 innerHTML 注入侧边栏会话行；React 树内请用组件版图标）。
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/clock.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function clockSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none"><path fill="currentColor" fill-rule="evenodd" d="M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0M8.75 4.5a.75.75 0 0 0-1.5 0V8a.75.75 0 0 0 .3.6l2 1.5a.75.75 0 1 0 .9-1.2l-1.7-1.275z" clip-rule="evenodd"/></svg>`
}
