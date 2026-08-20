import type { ComponentType, ReactNode, SVGProps } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { button } from './primitives'

/** 图标组件类型（@gravity-ui/icons 均为 SVG 组件） */
export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

const LOG_LIMIT = 5

/**
 * 通用加载/安装界面。
 *
 * 不传任何 props 时，渲染结果与官方 web shell 的 boot 加载页
 * （packages/client/web 的 AppRoot + AppRoot.module.css）逐项一致：
 * wordmark（16px/600/0.08em）+ 20px 2px 单色 spinner（0.8s 旋转，
 * 顶弧取 brand-primary，明暗主题下即黑/白）+ 12px/18px hint，16px gap。
 * 颜色通过 load-* 系列主题变量精确对应官方 dsw alias token。
 * spinner 动画直接抄官方（.animate-load-spin + @keyframes load-spin），
 * 不用 Tailwind animate-spin，避免 var() 间接层在 WebView2 下不旋转。
 * 传入 icon/title/subtitle/percentage/logs/errorMsg/onRetry 后按需扩展。
 */
export interface LoadableProps {
  /** 状态图标（@gravity-ui/icons 组件），仅失败态显示；加载态已有 spinner，不再叠加图标（官方 boot 页无图标） */
  icon?: IconComponent
  /** wordmark 位文案，默认官网的 "HARNESS" */
  title?: string
  /** hint 位文案，默认官网的 "Loading plugins…" */
  subtitle?: string
  /** 进度百分比（0-100），传入则显示进度条 */
  percentage?: number
  /** 安装日志行，传入则显示日志面板（空数组显示"等待日志"占位） */
  logs?: readonly string[]
  /** 错误信息，传入则切换为失败态（隐藏 spinner） */
  errorMsg?: string
  /** 失败态时的重试按钮回调 */
  onRetry?: () => void
  /** 错误态右侧的恢复内容；窄窗口自动改为上下排列 */
  sideContent?: ReactNode
  /** 附加内容，渲染在主内容后 */
  children?: ReactNode
}

export default function Loadable({
  icon: Icon,
  title,
  subtitle,
  percentage,
  logs,
  errorMsg,
  onRetry,
  sideContent,
  children,
}: LoadableProps) {
  const { t } = useTranslation()
  const error = errorMsg != null
  const wordmark = title ?? t('app.wordmark')
  const hint = error ? errorMsg : subtitle ?? t('status.loading_plugins')
  const hasLogs = logs != null
  const showPanel = hasLogs || percentage != null
  const hasSideContent = error && sideContent != null

  return (
    <div
      className={hasSideContent
        ? 'flex h-full min-h-0 items-start justify-center overflow-y-auto bg-load-bg -mt-[1px] py-4 sm:py-6'
        : 'flex h-full items-center justify-center bg-load-bg -mt-[1px]'}
    >
      <div className={hasSideContent ? 'flex w-[min(960px,92vw)] flex-col gap-6 lg:flex-row lg:items-start' : 'flex w-[min(460px,88vw)] flex-col items-center gap-4 text-center'}>
        <div className={hasSideContent ? 'flex min-w-0 flex-1 flex-col items-center gap-4 text-center lg:items-start lg:text-left' : 'contents'}>
          {/* 加载态显示 spinner 时隐藏图标（官方 boot 页即无图标），避免与 spinner 重复突兀；仅失败态显示 */}
          {error && Icon && <Icon className="size-7 text-load-ink" />}

          <span className="text-base leading-6 font-semibold tracking-[0.08em] text-load-ink truncate">{wordmark}</span>

          {error
            ? (
                // 失败态：官方 failed 展示样式（代码字体错误信息）
                <p className="min-h-[18px] max-w-full font-mono text-xs leading-[18px] break-all text-load-muted">{hint}</p>
              )
            : (
                <>
                  <span className="h-5 w-5 animate-load-spin rounded-full border-2 border-load-ring border-t-load-ink" />
                  <p className="min-h-[18px] text-xs leading-[18px] break-all text-load-muted">{hint}</p>
                </>
              )}

          {onRetry && (
            <button
              className={button({ tone: 'primary' })}
              onClick={onRetry}
            >
              {t('app.retry')}
            </button>
          )}

          {showPanel && (
            <div className="flex w-full flex-col gap-4">
              {percentage != null && (
                <div className="flex items-center gap-3">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-panel2" role="progressbar" aria-valuenow={Math.round(percentage)}>
                    <div className="h-full bg-gradient-to-r from-accent to-accent2 transition-[width] duration-150" style={{ width: `${Math.min(percentage, 100)}%` }} />
                  </div>
                  <span className="min-w-[44px] text-right text-[13px] font-semibold tabular-nums text-accent2">
                    {Math.round(percentage)}
                    %
                  </span>
                </div>
              )}
              {hasLogs && (
                <div className="min-h-[112px] max-h-[184px] overflow-y-auto rounded-lg border border-line bg-log-bg px-3.5 py-2.5 text-left font-mono text-xs leading-[1.7]" aria-label={t('ui.install_log')}>
                  {(logs!.length ? logs! : [t('ui.waiting_logs')]).slice(-LOG_LIMIT).map((line, index) => (
                    // 日志行内容可能重复，需以 index 区分 key
                    // eslint-disable-next-line react/no-array-index-key
                    <p key={`${line}-${index}`} className="m-0 flex gap-2 overflow-hidden text-ellipsis whitespace-nowrap text-log-ink">
                      <span className="shrink-0 text-accent select-none">›</span>
                      <span className="min-w-0 overflow-hidden text-ellipsis">{line}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {children}
        </div>

        <If cond={hasSideContent}>
          <aside className="w-full shrink-0 lg:w-[420px]">{sideContent}</aside>
        </If>
      </div>
    </div>
  )
}
