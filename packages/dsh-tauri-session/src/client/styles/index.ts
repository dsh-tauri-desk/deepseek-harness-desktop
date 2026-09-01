/** Archive page styles generated as css-render nodes. */
import { CssRender } from 'dsh-tauri/client'
import { SESSION_CLASSES as K, SESSION_STYLE_ID } from '../constants'

const cssr = CssRender()
const { c } = cssr

const archiveStyle = c([
  c(`.${K.page}`, {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    minHeight: '100%',
    color: 'var(--dsw-alias-label-primary)',
  }),
  c(`.${K.header}`, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  }),
  c(`.${K.title}`, {
    margin: 0,
    fontSize: '24px',
    lineHeight: '32px',
    fontWeight: 600,
  }),
  // 「全部删除」：红字 + hover 透明红底。官方 ghost hover 是单类 + :hover:not()
  // 的同特异性选择器，靠样式表顺序不保险，这里叠加双类抬高特异性保证覆盖。
  c(`.${K.deleteAll}`, {
    color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-danger-text, inherit))',
  }),
  c(`.${K.deleteAll}.${K.deleteAll}:hover:not(:disabled)`, {
    background: 'var(--dsw-alias-interactive-bg-hover-danger)',
  }),
  c(`.${K.archiveMenuItem}`, {
    color: 'var(--dsw-alias-label-primary) !important',
    background: 'transparent !important',
  }, [
    c('&:hover', {
      color: 'var(--dsw-alias-label-primary) !important',
      background: 'var(--dsw-alias-interactive-bg-hover) !important',
    }),
    c('&:focus', {
      color: 'var(--dsw-alias-label-primary) !important',
    }),
  ]),

  c(`.${K.toolbar}`, {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    padding: '8px 0',
    background: 'var(--dsw-alias-bg-base, var(--dsw-alias-bg-module-platform))',
  }),
  // 官方 Input 自带外观（32px 圆角框、focus 描边），这里只控制弹性宽度。
  c(`.${K.search}`, {
    flex: '1 1 220px',
    minWidth: 0,
  }),
  // 官方风格下拉触发器（MenuSelect）：对齐官方「通用设置」Select 的 pill 规格
  // （36px 高、全圆角、无边框、bg-module-platform 底、hover 换 interactive 底）。
  c(`.${K.menuSelect}`, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '12px',
    boxSizing: 'border-box',
    height: '36px',
    maxWidth: '220px',
    padding: '0 14px',
    border: 'none',
    borderRadius: '18px',
    background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '14px',
    lineHeight: '22px',
  }, [
    c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
  ]),
  c(`.${K.menuSelectLabel}`, {
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    minWidth: 0,
  }),
  c(`.${K.menuSelectChevron}`, {
    flex: 'none',
  }),
  c(`.${K.groups}`, {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  }),
  c(`.${K.group}`, {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  }),
  c(`.${K.groupHeader}`, {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '0 2px',
    color: 'var(--dsw-alias-label-secondary)',
  }),
  c(`.${K.groupTitle}`, {
    fontSize: '14px',
    lineHeight: '22px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  c(`.${K.groupCount}`, {
    fontSize: '13px',
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
    marginLeft: 'auto',
  }),
  c(`.${K.groupMenuTrigger}`, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    padding: 0,
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    fontSize: '18px',
    lineHeight: '1',
  }, [
    c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
  ]),
  // 重置 ul 默认 margin/padding/标记，行内边距由 .row 自行控制，去掉左侧缩进空白。
  c(`.${K.list}`, {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    border: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
    borderRadius: '12px',
    overflow: 'hidden',
  }),
  c(`.${K.row}`, {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    boxSizing: 'border-box',
    padding: '14px 16px',
    background: 'var(--dsw-alias-bg-base)',
    minHeight: '64px',
  }, [
    c('& + &', { borderTop: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.2))' }),
  ]),
  c(`.${K.rowMain}`, {
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  }),
  c(`.${K.rowTitle}`, {
    fontSize: '13px',
    lineHeight: '22px',
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  c(`.${K.rowTime}`, {
    fontSize: '13px',
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  c(`.${K.rowActions}`, {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  }),
  // 行内垃圾桶：官方 iconButton 规格（28px 圆角方形、hover 底色）。
  c(`.${K.rowDelete}`, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    flex: 'none',
    padding: 0,
    border: 'none',
    borderRadius: '6px',
    background: 'none',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
  }, [
    c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
  ]),
  c(`.${K.unarchive}`, {
    color: 'var(--dsw-alias-label-primary)',
  }),
  // 删除确认弹窗的「删除」按钮：危险色（浅红底 + 红字）。
  c(`.${K.deleteBtn}`, {
    background: 'var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover))',
    borderColor: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-border-l2))',
  }, [
  ]),
  c(`.${K.empty}`, {
    padding: '32px 0',
    textAlign: 'center',
    fontSize: '14px',
    lineHeight: '22px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  c(`.${K.error}`, {
    padding: '12px 16px',
    borderRadius: '10px',
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
    color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-danger-text, var(--dsw-alias-label-primary)))',
    fontSize: '13px',
    lineHeight: '20px',
  }),
  // 取消归档 toast 里的「查看」：内联链接式动作按钮（官方 Toast 文案槽不支持动作，
  // 这里以插件类名渲染内联按钮）。
  c(`.${K.toastView}`, {
    padding: 0,
    border: 'none',
    background: 'none',
    color: 'var(--dsw-alias-brand-primary)',
    font: 'inherit',
    cursor: 'pointer',
  }, [
    c('&:hover', { textDecoration: 'underline' }),
  ]),
])

export function mountSessionStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  if (cssr.find(SESSION_STYLE_ID) !== null)
    return () => {}
  archiveStyle.mount({ id: SESSION_STYLE_ID, head: true })
  return () => archiveStyle.unmount({ id: SESSION_STYLE_ID })
}
