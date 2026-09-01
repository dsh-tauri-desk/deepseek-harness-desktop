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
  c('.dpte-section', { display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', maxWidth: '760px', color: primary }),
  c('.dpte-tabs', { display: 'flex', alignItems: 'flex-end', gap: '22px', borderBottom: `1px solid ${border}`, marginTop: '2px' }),
  c('.dpte-tab', { position: 'relative', border: '0', padding: '7px 1px 9px', background: 'transparent', color: tertiary, font: 'inherit', fontSize: '13px', lineHeight: '20px', cursor: 'pointer' }),
  c('.dpte-tab:hover,.dpte-tab[data-active=\'true\']', { color: primary }),
  c('.dpte-tab[data-active=\'true\']::after,.dpte-tab:focus-visible::after', { position: 'absolute', right: '0', bottom: '-1px', left: '0', height: '2px', borderRadius: '2px 2px 0 0', background: primary, content: '\'\'' }),
  c('.dpte-tab:focus-visible', { outline: `2px solid ${business}`, outlineOffset: '2px', borderRadius: '2px', color: primary }),
  c('.dpte-tabPanel', { minWidth: '0', paddingTop: '2px' }),
  c('.dpte-head', { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }),
  c('.dpte-head h3,.dpte-listHead h3', { margin: '0', fontSize: '13px', lineHeight: '20px', fontWeight: '600' }),
  c('.dpte-head>svg', { flex: 'none', color: tertiary }),
  c('.dpte-intro,.dpte-empty', { margin: '0', fontSize: '13px', lineHeight: '20px', color: tertiary }),
  c('.dpte-listHead', { display: 'flex', alignItems: 'baseline', gap: '7px', padding: '0 2px', marginTop: '2px' }),
  c('.dpte-count', { fontSize: '12px', lineHeight: '18px', color: tertiary, fontVariantNumeric: 'tabular-nums' }),
  c('.dpte-spacer', { flex: '1' }),
  c('.dpte-refresh,.dpte-iconLink', { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '26px', height: '26px', border: '0', borderRadius: '6px', background: 'transparent', color: tertiary, cursor: 'pointer', textDecoration: 'none' }),
  c('.dpte-refresh:hover,.dpte-iconLink:hover', { background: hover, color: primary }),
  c('.dpte-refresh:focus-visible,.dpte-iconLink:focus-visible', { outline: `2px solid ${business}`, outlineOffset: '-2px' }),
  c('.dpte-cards', { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', alignItems: 'stretch', gap: '10px', margin: '0', padding: '0', listStyle: 'none' }),
  c('.dpte-cardsSingle', { gridTemplateColumns: 'minmax(0,1fr)' }),
  c('.dpte-card', { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '0', border: `1px solid ${border}`, borderRadius: '10px', background: layer3, padding: '12px 14px' }),
  c('.dpte-card:hover', { background: hover }),
  c('.dpte-cardMuted', { opacity: '.55' }),
  c('.dpte-cardTop,.dpte-cardRow', { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }),
  c('.dpte-cardTitle', { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '14px', lineHeight: '20px', fontWeight: '600', fontFamily: 'var(--ds-font-family-code)' }),
  c('.dpte-cardDesc', { margin: '0', fontSize: '12px', lineHeight: '18px', color: secondary, display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
  c('.dpte-tag', { display: 'inline-flex', alignItems: 'center', minHeight: '20px', borderRadius: '5px', padding: '1px 6px', background: layer1, color: secondary, fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap' }),
  c('.dpte-tag[data-kind=\'source\']', { background: `color-mix(in srgb,${business} 10%,transparent)`, color: business }),
  c('.dpte-tag[data-kind=\'off\']', { background: 'color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary)) 12%,transparent)', color: secondary }),
  c('.dpte-banner', { display: 'flex', alignItems: 'flex-start', gap: '8px', border: `1px solid ${border}`, borderRadius: '8px', padding: '10px 12px', background: layer3, fontSize: '13px', lineHeight: '20px' }),
  c('.dpte-banner[data-kind=\'ok\']', { borderColor: 'color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent)', background: 'color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)' }),
  c('.dpte-banner[data-kind=\'error\']', { borderColor: 'color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)', background: 'color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)' }),
  c('.dpte-banner[data-kind=\'info\']', { borderColor: `color-mix(in srgb,${business} 35%,transparent)`, background: `color-mix(in srgb,${business} 8%,transparent)` }),
  c('.dpte-bannerBody', { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '4px' }),
  c('.dpte-bannerHint', { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: secondary, fontSize: '12px', lineHeight: '18px' }),
  c('.dpte-form', { display: 'flex', flexDirection: 'column', gap: '10px' }),
  c('.dpte-editorTabs', { display: 'flex', gap: '4px', borderBottom: `1px solid ${border}` }),
  c('.dpte-editorTab', { position: 'relative', border: '0', padding: '7px 10px 9px', background: 'transparent', color: tertiary, font: 'inherit', fontSize: '13px', lineHeight: '20px', cursor: 'pointer' }),
  c('.dpte-editorTab:hover,.dpte-editorTab[data-active=\'true\']', { color: primary }),
  c('.dpte-editorTab[data-active=\'true\']::after', { position: 'absolute', right: '8px', bottom: '-1px', left: '8px', height: '2px', borderRadius: '2px 2px 0 0', background: primary, content: '\'\'' }),
  c('.dpte-editorTab:focus-visible', { outline: `2px solid ${business}`, outlineOffset: '-2px', borderRadius: '4px', color: primary }),
  c('.dpte-label', { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', lineHeight: '18px', color: secondary }),
  c('.dpte-label>span:first-child', { color: tertiary }),
  c('.dpte-input,.dpte-textarea,.dpte-select,.dpte-search', { width: '100%', boxSizing: 'border-box', border: `1px solid ${border}`, borderRadius: '8px', padding: '7px 10px', outline: 'none', background: layer1, color: primary, font: 'inherit', fontSize: '13px' }),
  c('.dpte-search', { width: '200px', padding: '4px 10px', fontSize: '12px', lineHeight: '18px' }),
  c('.dpte-textarea', { minHeight: '320px', resize: 'vertical', fontFamily: 'var(--ds-font-family-code)', lineHeight: '1.5' }),
  c('.dpte-textarea[data-short=\'true\']', { minHeight: '96px' }),
  c('.dpte-jsonEditor', { minHeight: '260px' }),
  c('.dpte-input:focus-visible,.dpte-textarea:focus-visible,.dpte-select:focus-visible,.dpte-search:focus-visible', { borderColor: business, boxShadow: `0 0 0 2px color-mix(in srgb,${business} 18%,transparent)` }),
  c('.dpte-checks', { display: 'flex', gap: '16px', fontSize: '13px', lineHeight: '20px' }),
  c('.dpte-checks label,.dpte-importChoice', { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', minWidth: '0' }),
  c('.dpte-importChoiceDisabled', { cursor: 'default' }),
  c('.dpte-formError', { margin: '0', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: '18px' }),
  c('.dpte-modalWide.dpte-modalWide', { width: 'min(680px,100%)' }),
  c('.dpte-modalForm.dpte-modalForm', { width: 'min(760px,100%)' }),
  c('.dpte-modalScroll.dpte-modalScroll', { maxHeight: 'calc(100vh - 160px)', overflowY: 'auto' }),
  c('.dpte-mdPreview', { minHeight: '320px', maxHeight: '60vh', overflowY: 'auto', border: `1px solid ${border}`, borderRadius: '8px', padding: '8px 12px', background: layer1, fontSize: '13px' }),
  c('.dpte-mdBody h1,.dpte-mdBody h2,.dpte-mdBody h3,.dpte-mdBody h4', { margin: '14px 0 6px', color: primary, lineHeight: '1.4' }),
  c('.dpte-mdBody h1', { fontSize: '18px' }),
  c('.dpte-mdBody h2', { fontSize: '16px' }),
  c('.dpte-mdBody h3', { fontSize: '14px' }),
  c('.dpte-mdBody h4', { fontSize: '13px' }),
  c('.dpte-mdBody p', { margin: '6px 0', lineHeight: '20px' }),
  c('.dpte-mdBody ul,.dpte-mdBody ol', { margin: '6px 0', paddingLeft: '20px' }),
  c('.dpte-mdBody code,.dpte-code', { fontFamily: 'var(--ds-font-family-code)', fontSize: '12px', background: layer3, borderRadius: '4px', padding: '1px 5px' }),
  c('.dpte-mdBody pre,.dpte-code', { margin: '8px 0', padding: '10px 12px', overflowX: 'auto', border: `1px solid ${border}`, borderRadius: '8px', background: layer3 }),
  c('.dpte-mdBody a,.dpte-link', { color: business }),
  c('.dpte-importScroll', { display: 'flex', flexDirection: 'column', gap: '14px', maxHeight: 'min(400px,52vh)', overflowY: 'auto', padding: '2px 4px 2px 2px' }),
  c('.dpte-importGroup', { display: 'flex', flexDirection: 'column', gap: '8px' }),
  c('.dpte-importHead', { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 2px' }),
  c('.dpte-importCount', { fontSize: '12px', lineHeight: '18px', color: tertiary }),
  c('.dpte-importAll', { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: secondary, cursor: 'pointer' }),
  c('.dpte-chips', { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }),
  c('.dpte-chip', { border: `1px solid ${border}`, borderRadius: '999px', padding: '2px 10px', background: 'transparent', color: secondary, font: 'inherit', fontSize: '12px', cursor: 'pointer' }),
  c('.dpte-chip:hover,.dpte-chip[data-active=\'true\']', { color: business, background: hover }),
  c('.dpte-switch', { position: 'relative', flex: 'none', width: '30px', height: '18px', border: '0', borderRadius: '999px', background: layer1, boxShadow: `inset 0 0 0 1px ${border}`, cursor: 'pointer' }),
  c('.dpte-switch[aria-checked=\'true\']', { background: `color-mix(in srgb,${business} 55%,transparent)`, boxShadow: 'none' }),
  c('.dpte-switchKnob', { position: 'absolute', top: '2px', left: '2px', width: '14px', height: '14px', borderRadius: '50%', background: primary, transition: 'left .15s' }),
  c('.dpte-switch[aria-checked=\'true\'] .dpte-switchKnob', { left: '14px', background: '#fff' }),
  c('.dpte-link', { border: '0', padding: '0', background: 'transparent', font: 'inherit', fontSize: '12px', lineHeight: '18px', cursor: 'pointer', textDecoration: 'none' }),
  c('.dpte-link:hover', { textDecoration: 'underline' }),
  c('.dpte-segments', { display: 'inline-flex', gap: '4px', border: `1px solid ${border}`, borderRadius: '8px', padding: '3px', background: layer1 }),
  c('.dpte-segment', { border: '0', borderRadius: '6px', padding: '4px 14px', background: 'transparent', color: secondary, font: 'inherit', fontSize: '12px', cursor: 'pointer' }),
  c('.dpte-segment[data-active=\'true\']', { background: hover, color: primary, fontWeight: '600' }),
  c('.dpte-format', { border: `1px solid ${border}`, borderRadius: '8px', padding: '8px 12px', background: layer1 }),
  c('.dpte-format summary', { fontSize: '12px', color: secondary, cursor: 'pointer' }),
  c('.dpte-formatHint', { margin: '2px 0 0', fontSize: '12px', color: tertiary }),
  c('.dpte-code', { fontSize: '11px', lineHeight: '17px', whiteSpace: 'pre' }),
  c('@media (max-width: 680px)', [c('.dpte-cards', { gridTemplateColumns: 'minmax(0,1fr)' }), c('.dpte-search', { width: '140px' })]),
])

export function mountExtensionStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  if (cssr.find(STYLE_ID) !== null)
    return () => {}
  styles.mount({ id: STYLE_ID, head: true })
  return () => styles.unmount({ id: STYLE_ID })
}
