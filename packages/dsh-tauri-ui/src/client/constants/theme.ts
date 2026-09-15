export const styles = {
  primary: 'var(--dsw-alias-label-primary)',
  secondary: 'var(--dsw-alias-label-secondary)',
  tertiary: 'var(--dsw-alias-label-tertiary)',
  dimmed: 'var(--dsw-alias-label-dimmed)',
  borderL2: 'var(--dsw-alias-border-l2)',
  borderL3: 'var(--dsw-alias-border-l3)',
  borderL4: 'var(--dsw-alias-border-l4)',
  brand: 'var(--dsw-alias-brand-primary)',
  business: 'var(--dsw-alias-state-business-primary)',
  layer1: 'var(--dsw-alias-bg-layer-1)',
  layer3: 'var(--dsw-alias-bg-layer-3)',
  modulePlatform: 'var(--dsw-alias-bg-module-platform)',
  font: 'var(--dsw-font-family)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
  hoverSolid: 'var(--dsw-alias-interactive-bg-hover-solid)',
  hoverDanger: 'var(--dsw-alias-interactive-bg-hover-danger)',
  error: 'var(--dsw-alias-state-error-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  primaryFill: 'var(--dsw-alias-button-primary-fill)',
  primaryHover: 'var(--dsw-alias-button-primary-hover)',
  primaryFg: 'var(--dsw-alias-label-primary-foreground)',
  focusRing: {
    boxShadow: '0 0 0 2px var(--dsw-alias-border-l3)',
    outline: 'none',
  },
  chevronSelectSvg: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
} as const

/**
 * 面板根容器：与官方会话内容列同宽的居中容器，并留出上下间距。
 *
 * `--dsh-chat-content-width` 由 `PanelWidthSync` 按官方公式发布在面板容器上（面板与会话根是
 * `main` 槽同级占位者，继承不到会话根的行内变量），这里的 clamp 只是未经同步时的兜底。
 */
export const panelContainer = {
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: 'var(--dsh-chat-content-width, clamp(680px, 64%, 920px))',
  marginInline: 'auto',
  paddingBlock: '24px',
} as const
