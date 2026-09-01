import type { ReactElement } from 'react'
import type { IconProps } from '../types'

export type { IconProps } from '../types'

/**
 * icons.tsx — 自绘内联 SVG 图标（Gravity 风格描边，currentColor）。
 * 不依赖 @deepseek-ai/dsh-client-ui-primitives 的类型/运行时（loader 模块表
 * 虽提供该模块，但自绘零外部表面、跨部署更稳）。
 */

/**
 * 新会话：官方 ChatOutline16 同款（聊天气泡 + 加号，fill 风格）。
 * primitives 包为 loader 运行时提供、不打进产物；此处自绘官方同一 path——
 * 取自桌面前端 bundle（dsh-web-frontend/dist/assets/index-ClqxG24t.js，导出表
 * ChatOutline16:V9），保证与官方「新会话」图标完全一致。
 */
export function ChatOutline({ size = 16, className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M8.00003 0.3237C3.76075 0.3237 0.32373 3.76072 0.32373 8C0.32373 9.17603 0.589121 10.2922 1.0632 11.2901L1.35291 11.8989L2.5705 11.3205L2.28079 10.7117C1.89079 9.89074 1.67301 8.97167 1.67301 8C1.67301 4.50546 4.50549 1.67298 8.00003 1.67298C11.4946 1.67298 14.3271 4.50546 14.3271 8C14.3271 11.4945 11.4946 14.327 8.00003 14.327C7.28473 14.327 6.76077 14.277 6.29621 14.1487C5.83857 14.0224 5.40441 13.8109 4.88514 13.4488C4.12569 12.919 3.03778 12.7316 2.141 13.2978L2.12682 13.307L2.11264 13.3171L1.34886 13.854L1.79659 15.188L2.86122 14.4384C3.19068 14.2305 3.68325 14.2542 4.11326 14.5539C4.72789 14.9826 5.30042 15.2724 5.93762 15.4484C6.56803 15.6224 7.22776 15.6763 8.00003 15.6763C12.2393 15.6763 15.6763 12.2393 15.6763 8C15.6763 3.76072 12.2393 0.3237 8.00003 0.3237ZM7.32033 4.82535V7.32536H4.82538V8.67464H7.32033V11.1747H8.6696V8.67464H11.1747V7.32536H8.6696V4.82535H7.32033Z" fill="currentColor" />
    </svg>
  )
}

/** 侧栏折叠开关：左侧面板轮廓（16 基准）。 */
export function PanelLeftOutline({ size = 16, className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/** 品牌 fallback：简化鱼形（sidebar.brand.mark 槽无 live 条目时的兜底，24 基准）。 */
export function FishMark({ size = 24, className }: IconProps): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M4 12c3-4.5 9-6 16-6 0 7-13 9-16 6Zm0 0c3 2.5 16 4.5 16-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="15.5" cy="9.5" r="1" fill="currentColor" />
    </svg>
  )
}
