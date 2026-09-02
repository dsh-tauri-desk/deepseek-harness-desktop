import { CssRender } from 'dsh-tauri/client'
import { STYLE_ID } from '../constants'

const cssr = CssRender()
const { c } = cssr
const primary = 'var(--dsw-alias-label-primary)'
const secondary = 'var(--dsw-alias-label-secondary)'
const tertiary = 'var(--dsw-alias-label-tertiary)'
const border = 'var(--dsw-alias-border-l2)'
const business = 'var(--dsw-alias-state-business-primary)'
const layer1 = 'var(--dsw-alias-bg-layer-1)'
const layer3 = 'var(--dsw-alias-bg-layer-3)'
const hover = 'var(--dsw-alias-interactive-bg-hover)'

const styles = c([
  c('.dsch-section', { display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', maxWidth: '760px', color: primary }),
  c('.dsch-head', { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }),
  c('.dsch-head h2', { margin: '0', fontSize: '15px', lineHeight: '22px', fontWeight: '600' }),
  c('.dsch-spacer', { flex: '1' }),
  c('.dsch-search', { width: '200px', boxSizing: 'border-box', border: `1px solid ${border}`, borderRadius: '8px', padding: '6px 10px', outline: 'none', background: layer1, color: primary, font: 'inherit', fontSize: '12px', lineHeight: '18px' }),
  c('.dsch-search:focus-visible', { borderColor: business, boxShadow: `0 0 0 2px color-mix(in srgb,${business} 18%,transparent)` }),
  c('.dsch-button', { display: 'inline-flex', alignItems: 'center', gap: '6px', border: `1px solid ${border}`, borderRadius: '8px', padding: '6px 12px', background: layer1, color: primary, font: 'inherit', fontSize: '12px', lineHeight: '18px', cursor: 'pointer' }),
  c('.dsch-button:hover', { background: hover, color: primary }),
  c('.dsch-button:focus-visible', { outline: `2px solid ${business}`, outlineOffset: '-2px' }),
  c('.dsch-buttonPrimary', { background: `color-mix(in srgb,${business} 55%,transparent)`, borderColor: 'transparent', color: '#fff' }),
  c('.dsch-buttonPrimary:hover', { background: `color-mix(in srgb,${business} 70%,transparent)` }),
  c('.dsch-buttonDanger', { color: 'var(--dsw-alias-state-error-primary)' }),
  c('.dsch-buttonGhost', { background: 'transparent', color: secondary }),
  c('.dsch-buttonGhost:hover', { background: hover, color: primary }),
  c('.dsch-buttonIcon', { width: '26px', height: '26px', padding: '0', justifyContent: 'center' }),
  c('.dsch-button:disabled', { opacity: '.55', cursor: 'default' }),
  c('.dsch-banner', { display: 'flex', alignItems: 'flex-start', gap: '8px', border: `1px solid ${border}`, borderRadius: '8px', padding: '9px 12px', background: layer3, fontSize: '12px', lineHeight: '18px', color: secondary }),
  c('.dsch-tabs', { display: 'flex', alignItems: 'flex-end', gap: '22px', borderBottom: `1px solid ${border}`, marginTop: '2px' }),
  c('.dsch-tab', { position: 'relative', border: '0', padding: '7px 1px 9px', background: 'transparent', color: tertiary, font: 'inherit', fontSize: '13px', lineHeight: '20px', cursor: 'pointer' }),
  c('.dsch-tab:hover,.dsch-tab[data-active=\'true\']', { color: primary }),
  c('.dsch-tab[data-active=\'true\']::after', { position: 'absolute', right: '0', bottom: '-1px', left: '0', height: '2px', borderRadius: '2px 2px 0 0', background: primary, content: '\'\'' }),
  c('.dsch-tab:focus-visible', { outline: `2px solid ${business}`, outlineOffset: '2px', borderRadius: '2px', color: primary }),
  c('.dsch-tabPanel', { minWidth: '0', paddingTop: '2px' }),
  c('.dsch-cards', { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', alignItems: 'stretch', gap: '10px', margin: '0', padding: '0', listStyle: 'none' }),
  c('@media (max-width: 680px)', [c('.dsch-cards', { gridTemplateColumns: 'minmax(0,1fr)' }), c('.dsch-search', { width: '140px' })]),
  c('.dsch-card', { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '0', border: `1px solid ${border}`, borderRadius: '10px', background: layer3, padding: '12px 14px' }),
  c('.dsch-card:hover', { background: hover }),
  c('.dsch-cardMuted', { opacity: '.6' }),
  c('.dsch-cardTop', { display: 'flex', alignItems: 'center', gap: '8px' }),
  c('.dsch-cardTitle', { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '14px', lineHeight: '20px', fontWeight: '600' }),
  c('.dsch-cardPrompt', { margin: '0', fontSize: '12px', lineHeight: '18px', color: secondary, display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
  c('.dsch-cardMeta', { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12px', lineHeight: '18px', color: tertiary }),
  c('.dsch-cardMetaRow', { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }),
  c('.dsch-tag', { display: 'inline-flex', alignItems: 'center', minHeight: '20px', borderRadius: '5px', padding: '1px 6px', background: layer1, color: secondary, fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap' }),
  c('.dsch-tag[data-kind=\'paused\']', { background: 'color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary)) 12%,transparent)', color: secondary }),
  c('.dsch-tag[data-kind=\'active\']', { background: `color-mix(in srgb,${business} 10%,transparent)`, color: business }),
  c('.dsch-cardActions', { display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }),
  c('.dsch-menu', { position: 'relative' }),
  c('.dsch-menuButton', { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '26px', height: '26px', border: '0', borderRadius: '6px', background: 'transparent', color: tertiary, cursor: 'pointer' }),
  c('.dsch-menuButton:hover,.dsch-menuButton[data-open=\'true\']', { background: hover, color: primary }),
  c('.dsch-menuPanel', { position: 'absolute', right: '0', top: 'calc(100% + 4px)', zIndex: 30, minWidth: '160px', border: `1px solid ${border}`, borderRadius: '8px', background: layer1, padding: '4px', boxShadow: '0 6px 20px rgba(0,0,0,.18)' }),
  c('.dsch-menuItem', { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', border: '0', borderRadius: '6px', padding: '6px 10px', background: 'transparent', color: primary, font: 'inherit', fontSize: '12px', lineHeight: '18px', cursor: 'pointer', textAlign: 'left' }),
  c('.dsch-menuItem:hover', { background: hover }),
  c('.dsch-menuItemDanger', { color: 'var(--dsw-alias-state-error-primary)' }),
  c('.dsch-empty', { margin: '0', padding: '24px 0', textAlign: 'center', fontSize: '13px', lineHeight: '20px', color: tertiary }),
  c('.dsch-error', { margin: '0', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: '18px' }),
  c('.dsch-runsList', { display: 'flex', flexDirection: 'column', gap: '6px', margin: '0', padding: '0', listStyle: 'none' }),
  c('.dsch-runRow', { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', border: `1px solid ${border}`, borderRadius: '8px', padding: '8px 12px', background: layer3, fontSize: '12px', lineHeight: '18px' }),
  c('.dsch-runName', { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '600', color: primary }),
  c('.dsch-runTime', { color: tertiary, fontVariantNumeric: 'tabular-nums' }),
  c('.dsch-runError', { width: '100%', margin: '0', color: 'var(--dsw-alias-state-error-primary)', fontSize: '11px', lineHeight: '16px', whiteSpace: 'pre-wrap' }),
  c('.dsch-status', { display: 'inline-flex', alignItems: 'center', minHeight: '20px', borderRadius: '5px', padding: '1px 6px', fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap' }),
  c('.dsch-status[data-status=\'succeeded\']', { background: 'color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)', color: 'var(--dsw-alias-state-success-primary)' }),
  c('.dsch-status[data-status=\'failed\']', { background: 'color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)', color: 'var(--dsw-alias-state-error-primary)' }),
  c('.dsch-status[data-status=\'running\'],.dsch-status[data-status=\'queued\']', { background: `color-mix(in srgb,${business} 12%,transparent)`, color: business }),
  c('.dsch-status[data-status=\'skipped\'],.dsch-status[data-status=\'cancelled\']', { background: 'color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary)) 12%,transparent)', color: secondary }),
  // —— 新建任务对话框 ——
  c('.dsch-overlay', { position: 'fixed', inset: '0', zIndex: 50, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', background: 'rgba(0,0,0,.4)', padding: '48px 16px', overflowY: 'auto' }),
  c('.dsch-dialog', { width: 'min(560px,100%)', display: 'flex', flexDirection: 'column', gap: '12px', border: `1px solid ${border}`, borderRadius: '12px', background: layer1, padding: '16px', boxShadow: '0 10px 40px rgba(0,0,0,.25)' }),
  c('.dsch-dialog h3', { margin: '0', fontSize: '15px', lineHeight: '22px', fontWeight: '600' }),
  c('.dsch-field', { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', lineHeight: '18px', color: secondary }),
  c('.dsch-field>span:first-child', { color: tertiary }),
  c('.dsch-input,.dsch-select,.dsch-textarea', { width: '100%', boxSizing: 'border-box', border: `1px solid ${border}`, borderRadius: '8px', padding: '7px 10px', outline: 'none', background: layer1, color: primary, font: 'inherit', fontSize: '13px' }),
  c('.dsch-textarea', { minHeight: '120px', resize: 'vertical', fontFamily: 'var(--ds-font-family-code)', lineHeight: '1.5' }),
  c('.dsch-input:focus-visible,.dsch-select:focus-visible,.dsch-textarea:focus-visible', { borderColor: business, boxShadow: `0 0 0 2px color-mix(in srgb,${business} 18%,transparent)` }),
  c('.dsch-row', { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }),
  c('.dsch-segments', { display: 'inline-flex', gap: '4px', border: `1px solid ${border}`, borderRadius: '8px', padding: '3px', background: layer1 }),
  c('.dsch-segment', { border: '0', borderRadius: '6px', padding: '4px 12px', background: 'transparent', color: secondary, font: 'inherit', fontSize: '12px', cursor: 'pointer' }),
  c('.dsch-segment[data-active=\'true\']', { background: hover, color: primary, fontWeight: '600' }),
  c('.dsch-weekdays', { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }),
  c('.dsch-weekday', { minWidth: '32px', border: `1px solid ${border}`, borderRadius: '6px', padding: '4px 6px', background: 'transparent', color: secondary, font: 'inherit', fontSize: '11px', cursor: 'pointer' }),
  c('.dsch-weekday[data-active=\'true\']', { background: `color-mix(in srgb,${business} 22%,transparent)`, color: business, borderColor: 'transparent' }),
  c('.dsch-dialogFooter', { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', marginTop: '2px' }),
])

export function mountSchedulerStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  if (cssr.find(STYLE_ID) !== null)
    return () => {}
  styles.mount({ id: STYLE_ID, head: true })
  return () => styles.unmount({ id: STYLE_ID })
}
