import { cssr } from 'dsh-tauri-ui/client'

const { bem: { b, e, m } } = cssr

export default b('worktree', [
  e('surface', {
    boxSizing: 'border-box',
    width: 'calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset))',
    maxWidth: 'calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset))',
    margin: '0 auto',
    alignSelf: 'center',
  }),
  e('surface-bar', {
    boxSizing: 'border-box',
    width: '100%',
    position: 'relative',
    height: '36px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '4px 5px 4px 12px',
    margin: '0 auto',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '12px',
    background: 'var(--dsw-specific-tip)',
    color: 'var(--dsw-alias-label-primary)',
    pointerEvents: 'auto',
  }),
  e('surface-content', { display: 'flex', alignItems: 'center', gap: '5px' }),
  e('surface-label', { fontSize: '13px', lineHeight: '20px', fontWeight: 500 }),
  e('action', {
    height: '26px',
    padding: '0 10px',
    border: 'none',
    borderRadius: '7px',
    fontFamily: 'inherit',
    fontSize: '12px',
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
    whiteSpace: 'nowrap',
  }, [
    m('log', { padding: 0, fontSize: '13px', background: 'transparent', textDecoration: 'underline' }),
    m('danger', { color: 'var(--dsw-alias-danger-foreground, #c0392b)', background: 'transparent' }),
  ]),
  e('spacer', { flex: 1 }),
  e('logs', {
    display: 'grid',
    gridTemplateRows: '0fr',
    opacity: 0,
    transition: 'grid-template-rows 180ms cubic-bezier(.16, 1, .3, 1), opacity 140ms ease',
  }, [
    m('open', { gridTemplateRows: '1fr', opacity: 1 }),
  ]),
  e('logs-inner', { minHeight: 0, overflow: 'hidden' }),
  e('logs-panel', {
    maxHeight: '180px',
    overflowY: 'auto',
    padding: '10px',
    borderRadius: '10px',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-base)',
    zIndex: 30,
  }),
  e('log-line', { fontSize: '12px', fontFamily: 'cursive', lineHeight: '16px' }),
])
