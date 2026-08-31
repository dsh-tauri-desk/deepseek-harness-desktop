import { CssRender } from 'dsh-tauri/client'
import { WORKTREE_STYLE_ID, worktreeStyles } from './constants'

export { worktreeStyles } from './constants'

export function mountWorktreeStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  const cssr = CssRender()
  if (cssr.find(WORKTREE_STYLE_ID) !== null)
    return () => {}
  const { c } = cssr
  const s = worktreeStyles
  const style = c([
    c(`.${s.surface}`, { boxSizing: 'border-box', width: 'calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset))', maxWidth: 'calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset))', margin: '0 auto', alignSelf: 'center' }),
    c(`.${s.surfaceBar}`, { boxSizing: 'border-box', width: '100%', position: 'relative', height: '36px', display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 5px 4px 12px', margin: '0 auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px', background: 'var(--dsw-specific-tip)', color: 'var(--dsw-alias-label-primary)', pointerEvents: 'auto' }),
    c(`.${s.surfaceContent}`, { display: 'flex', alignItems: 'center', gap: '5px' }),
    c(`.${s.surfaceLabel}`, { fontSize: '13px', lineHeight: '20px', fontWeight: 500 }),
    c(`.${s.action}`, { height: '26px', padding: '0 10px', border: 'none', borderRadius: '7px', fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))', whiteSpace: 'nowrap' }),
    c(`.${s.actionLog}`, { padding: 0, fontSize: '13px', background: 'transparent', textDecoration: 'underline' }),
    c(`.${s.actionDanger}`, { color: 'var(--dsw-alias-danger-foreground, #c0392b)', background: 'transparent' }),
    c(`.${s.spacer}`, { flex: 1 }),
    c(`.${s.logs}`, { display: 'grid', gridTemplateRows: '0fr', opacity: 0, transition: 'grid-template-rows 180ms cubic-bezier(.16, 1, .3, 1), opacity 140ms ease' }),
    c(`.${s.logsOpen}`, { gridTemplateRows: '1fr', opacity: 1 }),
    c(`.${s.logsInner}`, { minHeight: 0, overflow: 'hidden' }),
    c(`.${s.logsPanel}`, { maxHeight: '180px', overflowY: 'auto', padding: '10px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', zIndex: 30 }),
    c(`.${s.logLine}`, { fontSize: '12px', fontFamily: 'cursive', lineHeight: '16px' }),
    c(`.${s.modal}`, { position: 'absolute', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.4)' }),
    c(`.${s.card}`, { boxSizing: 'border-box', width: 'min(460px, calc(100vw - 48px))', padding: '20px 22px', borderRadius: '16px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', boxShadow: '0 24px 64px rgba(0,0,0,0.28)', display: 'flex', flexDirection: 'column', gap: '14px' }),
    c(`.${s.title}`, { fontSize: '16px', fontWeight: 600, lineHeight: '24px', margin: 0 }),
    c(`.${s.body}`, { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))', margin: 0 }),
    c(`.${s.field}`, { display: 'flex', flexDirection: 'column', gap: '6px' }),
    c(`.${s.fieldLabel}`, { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))' }),
    c(`.${s.inputWrap}`, { display: 'flex', alignItems: 'center', gap: 0, border: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.25))', borderRadius: '10px', overflow: 'hidden', background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.06))' }),
    c(`.${s.input}`, { flex: 1, minWidth: 0, height: '36px', padding: '0 10px', border: 'none', background: 'none', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: '13px', outline: 'none' }),
    c(`.${s.pathRow}`, { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '12px', lineHeight: '18px' }),
    c(`.${s.pathKey}`, { flex: 'none', color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))' }),
    c(`.${s.pathValue}`, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }),
    c(`.${s.error}`, { fontSize: '12px', lineHeight: '18px', color: '#c0392b' }),
    c(`.${s.footer}`, { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '4px' }),
    c(`.${s.button}`, { boxSizing: 'border-box', height: '36px', padding: '0 16px', border: 'none', borderRadius: '10px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap' }),
    c(`.${s.buttonGhost}`, { color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))' }),
    c(`.${s.buttonPrimary}`, { color: '#fff', background: 'var(--dsw-alias-bg-accent, #2f6feb)' }),
    c(`.${s.buttonDanger}`, { color: '#fff', background: '#c0392b' }),
    c(`.${s.buttonDisabled}`, { opacity: 0.5, cursor: 'not-allowed' }),
  ])
  style.mount({ id: WORKTREE_STYLE_ID, head: true })
  return () => style.unmount({ id: WORKTREE_STYLE_ID })
}
