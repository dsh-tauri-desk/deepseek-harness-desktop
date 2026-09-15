import { cssr } from 'dsh-tauri-ui/client'

const { c } = cssr

export default c([
  c('.dshp-mode-select__trigger', {
    boxSizing: 'border-box',
    minWidth: 0,
    maxWidth: '220px',
    height: '28px',
    padding: '0 4px 0 8px',
    border: 'none',
    borderRadius: '24px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontFamily: 'var(--dsw-font-family, inherit)',
    fontSize: '13px',
    fontWeight: 500,
    lineHeight: '20px',
    cursor: 'pointer',
    outline: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    whiteSpace: 'nowrap',
  }, [
    c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
    c('&:focus-visible', { boxShadow: '0 0 0 2px var(--dsw-alias-border-l3)' }),
  ]),
  c('.dshp-mode-select__trigger.dshp-mode-select__trigger--open', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
  c('.dshp-mode-select__label', { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  c('.dshp-mode-select__icon', { color: 'var(--dsw-alias-label-primary)', display: 'inline-flex', flex: 'none' }),
  c('.dshp-mode-select__chevron', { color: 'var(--dsw-alias-label-caption)', flex: 'none' }),
  c('.dshp-mode-select__host', { display: 'inline-flex', alignItems: 'center', flex: 'none' }),
  c('.dshp-mode-select__anchor', { display: 'none' }),
])
