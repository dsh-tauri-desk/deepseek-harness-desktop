/**
 * components/pet-settings.cssr.ts — 设置分区面样式（页签 / 工具栏 / 描述 / 尺寸滑条）。
 *
 * 全部走 `--dsw-alias-*` 主题变量，明暗主题自适应；工具栏按钮取与卡片操作按钮同尺寸的
 * 小号 secondary（官方 36px 胶囊在本工具栏过大会挤压页签行）。卡片样式见 pet-card.cssr.ts。
 */
import { cssr } from 'dsh-tauri-ui/client'

const { c } = cssr

export default c([
  c('.dshp-pet__page', {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    color: 'var(--dsw-alias-label-primary)',
  }),
  c('.dshp-pet__tabs', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    flexWrap: 'wrap',
    margin: '4px 0 14px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  }),
  c('.dshp-pet__tab-list', { display: 'flex', alignItems: 'center', gap: '16px' }),
  c('.dshp-pet__tab-btn', {
    appearance: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: '13px',
    lineHeight: '1.5',
    border: '0',
    borderBottom: '2px solid transparent',
    cursor: 'pointer',
    padding: '8px 0',
  }, [
    c('&:hover', { color: 'var(--dsw-alias-label-primary)' }),
  ]),
  c('.dshp-pet__tab-btn.dshp-pet__tab-btnActive', {
    borderBottomColor: 'currentColor',
    color: 'var(--dsw-alias-label-primary)',
    fontWeight: '650',
  }),
  c('.dshp-pet__tab-tools', { display: 'flex', alignItems: 'center', gap: '6px' }),
  c('.dshp-pet__tool-btn', {
    flex: 'none',
    appearance: 'none',
    cursor: 'pointer',
    padding: '5px 10px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '12px',
    lineHeight: '18px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    whiteSpace: 'nowrap',
  }, [
    c('&:hover:not(:disabled)', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
    c('&:disabled', { opacity: '0.4', cursor: 'default' }),
    c('&:focus-visible', {
      boxShadow: '0 0 0 2px var(--dsw-alias-border-l3)',
      outline: 'none',
    }),
  ]),
  c('.dshp-pet__tab-desc', {
    margin: '0',
    fontSize: '13px',
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  c('.dshp-pet__divider', {
    border: '0',
    borderTop: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
  }),
  c('.dshp-pet__size-row', { display: 'flex', alignItems: 'center', gap: '12px' }),
  c('.dshp-pet__size-label', { flex: 'none', fontWeight: '500' }),
  c('.dshp-pet__size-slider', {
    flex: '1',
    accentColor: 'var(--dsw-alias-brand-primary)',
    cursor: 'pointer',
  }),
  c('.dshp-pet__hint', {
    margin: '0',
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  c('.dshp-pet__empty', {
    padding: '24px 16px',
    textAlign: 'center',
    fontSize: '13px',
    lineHeight: '20px',
    borderRadius: '12px',
    border: '1px dashed var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  // 初次加载占位（首次打开设置页、清单尚未到达时显示，避免空卡片闪烁）。
  c('.dshp-pet__loading', {
    padding: '24px 16px',
    textAlign: 'center',
    fontSize: '13px',
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  c('.dshp-pet__error', {
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-danger-text, #ff7a7a))',
  }),
])
