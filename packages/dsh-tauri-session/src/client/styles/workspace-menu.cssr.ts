import { cssr } from 'dsh-tauri-ui/client'

const { c } = cssr

/**
 * 工作区菜单里克隆出的「归档工作区」条目外观：官方 `.danger` 样式不带 `!important`，
 * 这里的同层声明可稳定覆盖，无需 JS hover 监听或内联 !important。
 */
export default c([
  c(`.dshp-session__archive-menu-item`, {
    color: 'var(--dsw-alias-label-primary) !important',
    background: 'transparent !important',
  }, [
    c('&:hover:not(:disabled)', {
      color: 'var(--dsw-alias-label-primary) !important',
      background: 'var(--dsw-alias-interactive-bg-hover) !important',
    }),
    c('&:focus', {
      color: 'var(--dsw-alias-label-primary) !important',
    }),
    c(`[class*="itemIcon"]`, {
      color: 'var(--dsw-alias-label-tertiary) !important',
    }),
  ]),
])
