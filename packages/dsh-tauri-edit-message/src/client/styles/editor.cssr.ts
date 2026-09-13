/**
 * client/styles/editor.cssr.ts — 编辑面板样式（BEM 块 `edit-message`）。
 *
 * 只作用于插件自己注入的节点；官方气泡 / 操作行的外观保持内核原样。
 * 颜色一律走共享设计 token（`theme.ts` 的同一批变量），亮色与暗色主题自动适配。
 *
 * 选择器一律由 bem 助手生成（块 `.dshp-edit-message`、元素 `__elem`、修饰符 `--mod`），
 * 不手写类名字符串；组件侧的 class 名与这里逐字对应（与仓库其余组件同一约定）。
 */

import { cssr, styles as sharedStyles } from 'dsh-tauri-ui/client'

const { c, bem: { b, e, m } } = cssr
const shared = sharedStyles
const { primary, secondary, tertiary, borderL2, modulePlatform, hover, error, primaryFill, primaryHover, primaryFg } = shared

export default c([
  b('edit-message', {}, [
    // 追加在官方操作行里的 Edit 图标按钮：外观与官方 `.xzv4MW_action` 对齐，
    // 这里只兜底尺寸，避免官方类名换代时按钮塌陷。
    e('edit-btn', {
      width: '28px',
      height: '28px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '6px',
      border: 'none',
      borderRadius: '28px',
      background: 'transparent',
      color: tertiary,
      cursor: 'pointer',
    }),
    c('&:hover', { background: hover, color: secondary }),
    c('& svg', { width: '15px', height: '15px' }),

    // 官方没有操作行（echo / pending 行）时自建的一条操作行。
    e('own-actions', {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: '8px',
    }),

    // 编辑面板：宽 100%、圆角、灰底；操作区在右下角。
    e('editor', {
      width: '100%',
      boxSizing: 'border-box',
      background: modulePlatform,
      border: `1px solid ${borderL2}`,
      borderRadius: '8px',
      padding: '10px 12px 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    }),
    e('textarea', {
      width: '100%',
      minHeight: '46px',
      maxHeight: '320px',
      resize: 'vertical',
      border: '0',
      outline: 'none',
      background: 'transparent',
      color: primary,
      font: 'inherit',
      fontSize: 'var(--dsh-content-font-size,14px)',
      lineHeight: 'calc(22px + var(--dsh-content-font-delta,0px))',
    }),
    e('actions', {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '8px',
    }),
    // 次级按钮：「取消」。
    e('btn', {
      padding: '4px 14px',
      borderRadius: '8px',
      border: `1px solid ${borderL2}`,
      background: 'var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))',
      font: 'inherit',
      fontSize: '13px',
      color: primary,
      cursor: 'pointer',
    }, [
      c('&:hover', { background: hover }),
      c('&[disabled]', { opacity: '.5', cursor: 'default' }),
      // 主按钮：「发送」——黑底白字（前景色必须显式指定，否则继承 label-primary 会黑底黑字）。
      m('primary', {
        background: primaryFill,
        borderColor: 'transparent',
        color: primaryFg,
      }, [
        c('&:hover', { background: primaryHover, color: primaryFg }),
      ]),
    ]),
    e('error', { fontSize: '12px', color: error }),
  ]),
])
