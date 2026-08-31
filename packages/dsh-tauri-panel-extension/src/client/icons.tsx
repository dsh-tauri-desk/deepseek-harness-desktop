import type { ReactElement } from 'react'
import type { IconProps } from './types'

/**
 * Gravity UI Icons `puzzle.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/puzzle.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconExtension({ size, className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size || '1em'} height={size || '1em'} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d="M5.731 4H4.5A1.5 1.5 0 0 0 3 5.5v.377a2.72 2.72 0 0 1 0 5.246v.377A1.5 1.5 0 0 0 4.5 13h.377a2.72 2.72 0 0 1 5.246 0h.377a1.5 1.5 0 0 0 1.5-1.5v-1.232l1-.353a1.501 1.501 0 0 0 0-2.83l-1-.354V5.5A1.5 1.5 0 0 0 10.5 4H9.269l-.354-1a1.501 1.501 0 0 0-2.83 0zM8.9 14.5l-.204-1.02a1.22 1.22 0 0 0-2.392 0L6.1 14.5H4.5a3 3 0 0 1-3-3V9.9l1.02-.204a1.22 1.22 0 0 0 0-2.392L1.5 7.1V5.5a3 3 0 0 1 3-3h.17a3.001 3.001 0 0 1 5.66 0h.17a3 3 0 0 1 3 3v.17a3.001 3.001 0 0 1 0 5.66v.17a3 3 0 0 1-3 3z" clipRule="evenodd" />
    </svg>
  )
}

/**
 * Gravity UI Icons `graduation-cap.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/graduation-cap.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconSkill({ size = 16, className }: IconProps): ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true"><path fill="currentColor" fillRule="evenodd" d="M6.836 3.202 1.74 5.386a.396.396 0 0 0 0 .728l5.096 2.184a2.5 2.5 0 0 0 .985.202h.358a2.5 2.5 0 0 0 .985-.202l5.096-2.184a.396.396 0 0 0 0-.728L9.164 3.202A2.5 2.5 0 0 0 8.179 3h-.358a2.5 2.5 0 0 0-.985.202M1.5 7.642l1.5.644v3.228a2 2 0 0 0 1.106 1.789l.806.403a7 7 0 0 0 6.193.033l.909-.442a2 2 0 0 0 1.125-1.798V8.226l1.712-.734a1.896 1.896 0 0 0 0-3.484L9.755 1.823A4 4 0 0 0 8.179 1.5h-.358a4 4 0 0 0-1.576.323L1.15 4.008A1.9 1.9 0 0 0 0 5.75v4.5a.75.75 0 0 0 1.5 0zm3 3.872V8.929l1.745.748A4 4 0 0 0 7.821 10h.358a4 4 0 0 0 1.576-.323l1.884-.808v2.63a.5.5 0 0 1-.282.45l-.909.442a5.5 5.5 0 0 1-4.865-.027l-.807-.403a.5.5 0 0 1-.276-.447" clipRule="evenodd" /></svg>
}

/**
 * Gravity UI Icons `arrows-rotate-right.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/arrows-rotate-right.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconRefresh({ size = 14, className }: IconProps): ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true"><path fill="currentColor" d="M13.78 2.22a.75.75 0 0 1 0 1.06l-1.03 1.03A6.25 6.25 0 1 1 8 1.75a.75.75 0 0 1 0 1.5 4.75 4.75 0 1 0 3.72 1.8l-1.19 1.2A.75.75 0 0 1 9.25 5.72V2.5a.75.75 0 0 1 .75-.75h3.25a.75.75 0 0 1 .53.47" /></svg>
}

/**
 * Gravity UI Icons `logo-github.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/logo-github.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconGitHub({ size = 16, className }: IconProps): ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true"><path fill="currentColor" fillRule="evenodd" d="M8 .75a7.25 7.25 0 0 0-2.29 14.13c.36.07.5-.16.5-.35v-1.39c-2.04.44-2.47-.87-2.47-.87-.33-.85-.81-1.08-.81-1.08-.67-.45.05-.44.05-.44.73.05 1.12.75 1.12.75.66 1.12 1.72.8 2.14.61.07-.47.26-.8.47-.98-1.63-.18-3.34-.81-3.34-3.63 0-.8.29-1.46.75-1.97-.07-.19-.32-.93.08-1.94 0 0 .61-.2 1.99.75A6.9 6.9 0 0 1 8 4.06c.62 0 1.23.08 1.81.24 1.38-.95 1.99-.75 1.99-.75.4 1.01.15 1.75.08 1.94.46.51.75 1.17.75 1.97 0 2.82-1.72 3.44-3.35 3.62.26.23.5.67.5 1.35v2.1c0 .19.13.42.5.35A7.25 7.25 0 0 0 8 .75" clipRule="evenodd" /></svg>
}

/**
 * Gravity UI Icons `plug-connection.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/plug-connection.svg
 * License: MIT, © 2022 YANDEX LLC.
 */
export function IconMcp({ size = 16, className }: IconProps): ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true"><path fill="currentColor" fillRule="evenodd" d="M15.53 1.53A.75.75 0 0 0 14.47.47l-1.29 1.29a4.24 4.24 0 0 0-5.423.483l-.58.58a.96.96 0 0 0 0 1.354l4.646 4.646a.96.96 0 0 0 1.354 0l.58-.58a4.24 4.24 0 0 0 .484-5.423zm-8.5 4.94a.75.75 0 0 1 0 1.06L5.78 8.78l1.44 1.44 1.25-1.25a.75.75 0 0 1 1.06 1.06l-1.25 1.25.543.543a.96.96 0 0 1 0 1.354l-.58.58a4.24 4.24 0 0 1-5.423.484l-1.29 1.29A.75.75 0 0 1 .47 14.47l1.29-1.29a4.24 4.24 0 0 1 .483-5.423l.58-.58a.96.96 0 0 1 1.354 0l.543.543 1.25-1.25a.75.75 0 0 1 1.06 0M3.5 8.62l-.197.197a2.743 2.743 0 0 0 3.879 3.879l.197-.197zm9.197-1.439-.197.197L8.621 3.5l.197-.197a2.743 2.743 0 0 1 3.879 3.879" clipRule="evenodd" /></svg>
}
