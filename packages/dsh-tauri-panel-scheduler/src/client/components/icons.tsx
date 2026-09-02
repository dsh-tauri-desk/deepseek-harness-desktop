import type { ReactElement } from 'react'
import type { IconProps } from '../types'

/**
 * icons.tsx — 自绘内联 SVG 图标（Gravity 风格描边，currentColor）。
 * 不依赖 @deepseek-ai/dsh-client-ui-primitives 的类型/运行时（自绘零外部表面）。
 */

/** 时钟/定时任务图标（面板条目）。 */
export function IconSchedule({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  )
}

/** 更多操作（…）菜单按钮图标。 */
export function IconMore({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  )
}

/** 刷新图标。 */
export function IconRefresh({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0-2.34 5.66" />
      <path d="M20 4v7h-7" />
    </svg>
  )
}

/** 加号图标（新建）。 */
export function IconPlus({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
  )
}

/** 播放（立即运行）图标。 */
export function IconPlay({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a.8.8 0 0 0 1.2.7l10-6.5a.8.8 0 0 0 0-1.4l-10-6.5A.8.8 0 0 0 8 5.5Z" /></svg>
  )
}

/** 暂停图标。 */
export function IconPause({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6.5" y="5" width="3.4" height="14" rx="1" />
      <rect x="14.1" y="5" width="3.4" height="14" rx="1" />
    </svg>
  )
}

/** 删除图标。 */
export function IconTrash({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /></svg>
  )
}

/** 聊天（通过 Chat 创建）图标。 */
export function IconChat({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.35-4.1-1L3 20l1.1-5.2A8.5 8.5 0 1 1 21 11.5Z" /></svg>
  )
}

/** 搜索图标。 */
export function IconSearch({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

/** 信息图标（提示横幅）。 */
export function IconInfo({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M12 12v4" />
    </svg>
  )
}

/** 关闭（X）图标。 */
export function IconClose({ className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
