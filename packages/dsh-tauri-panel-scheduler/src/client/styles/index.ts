import { CssRender } from 'dsh-tauri/client'
import { STYLE_ID } from '../constants'

/**
 * styles/index.ts — 定时任务面板样式（DeepSeek 设计令牌 + 原生控件）。
 *
 * 与 dsh-automation / dsh-knj-scheduler 一致：一律使用 --dsw-alias-* 设计令牌，
 * 控件用原生 <button>/<input>/<select>/<textarea>，不自定义绘制下拉/分段/菜单；
 * 仅对布局与边框/圆角/填充做补充。
 */

const cssr = CssRender()
const { c } = cssr
const primary = 'var(--dsw-alias-label-primary)'
const secondary = 'var(--dsw-alias-label-secondary)'
const tertiary = 'var(--dsw-alias-label-tertiary)'
const border = 'var(--dsw-alias-border-l2)'
const business = 'var(--dsw-alias-state-business-primary)'
const layer1 = 'var(--dsw-alias-bg-layer-1)'
const layer2 = 'var(--dsw-alias-bg-layer-2)'
const layer3 = 'var(--dsw-alias-bg-layer-3)'
const hover = 'var(--dsw-alias-interactive-bg-hover)'
const error = 'var(--dsw-alias-state-error-primary)'
const success = 'var(--dsw-alias-state-success-primary)'
const primaryFill = 'var(--dsw-alias-button-primary-fill)'
const primaryFg = 'var(--dsw-alias-label-primary-foreground)'
const font = 'var(--dsw-font-family)'

const styles = c([
  // —— 面板外壳 / 页头 ——
  c('.dsch-shell', { boxSizing: 'border-box', maxWidth: '1080px', width: '100%', margin: '0 auto', padding: '0 0 32px', color: primary, fontFamily: font, fontSize: '13px', lineHeight: '1.5' }),
  c('.dsch-top', { display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '12px' }),
  c('.dsch-heading h1', { margin: '0', fontSize: '20px', lineHeight: '28px', fontWeight: '650', letterSpacing: '-.2px' }),
  c('.dsch-heading p', { margin: '4px 0 0', color: tertiary, fontSize: '13px', lineHeight: '1.5' }),
  c('.dsch-toolbar', { display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: '8px' }),
  c('.dsch-search', { flex: '1', minWidth: '0', maxWidth: '280px', height: '32px', padding: '0 12px', border: `1px solid ${border}`, borderRadius: '8px', background: layer3, color: 'inherit', font: 'inherit', fontSize: '13px', outline: 'none' }),
  c('.dsch-search:focus-visible', { borderColor: business, boxShadow: `0 0 0 2px color-mix(in srgb,${business} 18%,transparent)` }),
  c('.dsch-searchWrap', { position: 'relative', display: 'inline-flex', flex: '1', minWidth: '0', maxWidth: '280px' }),
  c('.dsch-searchWrap .dsch-search', { width: '100%', maxWidth: 'none', padding: '0 12px 0 32px' }),
  c('.dsch-searchIcon', { position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: tertiary }),

  // —— 按钮（原生 button + 令牌）——
  c('.dsch-btn', { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', minHeight: '32px', padding: '0 12px', border: `1px solid ${border}`, borderRadius: '8px', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap' }),
  c('.dsch-btn:hover', { background: hover }),
  c('.dsch-btn:disabled', { opacity: '.55', cursor: 'default' }),
  c('.dsch-btn--primary', { borderColor: 'transparent', background: primaryFill, color: primaryFg }),
  c('.dsch-btn--danger', { borderColor: `color-mix(in srgb,${error} 45%,transparent)`, color: error }),
  c('.dsch-iconBtn', { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', border: '0', borderRadius: '8px', background: 'transparent', color: tertiary, cursor: 'pointer' }),
  c('.dsch-iconBtn:hover', { background: hover, color: primary }),

  // —— 提示横幅 ——
  c('.dsch-banner', { display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '14px', padding: '10px 14px', border: `1px solid ${border}`, borderRadius: '12px', background: layer2, color: secondary, fontSize: '13px', lineHeight: '1.5' }),
  c('.dsch-banner>span', { display: 'inline-flex', alignItems: 'flex-start', gap: '8px' }),
  c('.dsch-banner svg', { flex: 'none', marginTop: '1px' }),

  // —— Tabs ——
  c('.dsch-tabs', { display: 'flex', alignItems: 'center', gap: '16px', margin: '4px 0 14px', borderBottom: `1px solid ${border}` }),
  c('.dsch-tab', { padding: '8px 0', border: '0', borderBottom: '2px solid transparent', background: 'transparent', color: secondary, font: 'inherit', fontSize: '13px', cursor: 'pointer' }),
  c('.dsch-tab:hover', { color: primary }),
  c('.dsch-tab.is-on', { borderBottomColor: 'currentColor', color: primary, fontWeight: '650' }),

  // —— 任务卡片 ——
  c('.dsch-cards', { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '12px', margin: '0', padding: '0', listStyle: 'none' }),
  c('@media (max-width: 680px)', [c('.dsch-cards', { gridTemplateColumns: 'minmax(0,1fr)' }), c('.dsch-searchWrap', { maxWidth: '160px' })]),
  c('.dsch-card', { position: 'relative', minWidth: '0', padding: '14px 16px', border: `1px solid ${border}`, borderRadius: '12px', background: layer2, color: primary }),
  c('.dsch-card:hover', { borderColor: `color-mix(in srgb,${business} 45%,transparent)` }),
  c('.dsch-card.is-paused', { opacity: '.6' }),
  c('.dsch-cardTitle', { display: 'block', margin: '0 0 6px', fontSize: '14px', lineHeight: '20px', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  c('.dsch-cardMeta', { display: 'flex', alignItems: 'center', gap: '10px', minWidth: '0' }),
  c('.dsch-cardMetaText', { flex: '1', minWidth: '0', color: tertiary, fontSize: '12px', lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  c('.dsch-cardMetaText strong', { color: secondary, fontWeight: '600' }),
  c('.dsch-more', { flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', border: '0', borderRadius: '8px', background: 'transparent', color: tertiary, cursor: 'pointer' }),
  c('.dsch-more:hover,.dsch-more[data-open=\'true\']', { background: hover, color: primary }),

  // —— 卡片 [...] 菜单（原生按钮 + 面板）——
  c('.dsch-menu', { position: 'relative' }),
  c('.dsch-menuPanel', { position: 'absolute', right: '0', top: 'calc(100% + 6px)', zIndex: 30, minWidth: '148px', padding: '6px', border: `1px solid ${border}`, borderRadius: '12px', background: 'var(--dsw-alias-bg-base)', boxShadow: 'var(--dsw-shadow-lv3,0 10px 30px rgba(0,0,0,.28))' }),
  c('.dsch-menuItem', { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 10px', border: '0', borderRadius: '8px', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '13px', cursor: 'pointer', textAlign: 'left' }),
  c('.dsch-menuItem:hover', { background: hover }),
  c('.dsch-menuItem.is-danger', { color: error }),

  // —— 状态 ——
  c('.dsch-error', { margin: '0', color: error, fontSize: '12px', lineHeight: '18px' }),
  c('.dsch-empty', { margin: '0', padding: '48px 0', color: tertiary, fontSize: '13px', textAlign: 'center' }),
  c('.dsch-muted', { margin: '0', color: secondary, fontSize: '12px' }),

  // —— 执行记录 ——
  c('.dsch-runsList', { display: 'flex', flexDirection: 'column', gap: '8px', margin: '0', padding: '0', listStyle: 'none' }),
  c('.dsch-runRow', { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 14px', border: `1px solid ${border}`, borderRadius: '10px', background: layer2, fontSize: '13px', lineHeight: '20px' }),
  c('.dsch-runName', { flex: '1', minWidth: '120px', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  c('.dsch-runTime', { color: tertiary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }),
  c('.dsch-runError', { width: '100%', margin: '0', color: error, fontSize: '12px', lineHeight: '16px', whiteSpace: 'pre-wrap' }),
  c('.dsch-chip', { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 10px', borderRadius: '999px', background: layer3, color: secondary, fontSize: '12px', whiteSpace: 'nowrap' }),
  c('.dsch-chip[data-status=\'succeeded\']', { background: `color-mix(in srgb,${success} 12%,transparent)`, color: success }),
  c('.dsch-chip[data-status=\'failed\']', { background: `color-mix(in srgb,${error} 12%,transparent)`, color: error }),
  c('.dsch-chip[data-status=\'running\'],.dsch-chip[data-status=\'queued\']', { background: `color-mix(in srgb,${business} 12%,transparent)`, color: business }),

  // —— 新建任务对话框（原生控件）——
  c('.dsch-mask', { position: 'fixed', inset: '0', zIndex: 40, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 16px', overflowY: 'auto', background: 'rgba(0,0,0,.45)' }),
  c('.dsch-dialog', { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '14px', width: 'min(640px,100%)', maxHeight: 'calc(100vh - 96px)', overflowY: 'auto', padding: '22px 24px', border: `1px solid ${border}`, borderRadius: '16px', background: 'var(--dsw-alias-bg-base)', boxShadow: 'var(--dsw-shadow-lv3,0 12px 36px rgba(0,0,0,.36))', color: primary, fontFamily: font }),
  c('.dsch-dialogHead', { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }),
  c('.dsch-dialogHead h2', { margin: '0 0 4px', fontSize: '18px', lineHeight: '24px', fontWeight: '650' }),
  c('.dsch-dialogHead p', { margin: '0', color: secondary, fontSize: '13px', lineHeight: '1.5' }),
  c('.dsch-dialogClose', { flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', border: '0', borderRadius: '8px', background: 'transparent', color: tertiary, fontSize: '18px', lineHeight: '1', cursor: 'pointer' }),
  c('.dsch-dialogClose:hover', { background: hover, color: primary }),
  c('.dsch-field', { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0', fontSize: '13px' }),
  c('.dsch-fieldLabel', { color: secondary, lineHeight: '18px' }),
  c('.dsch-field input,.dsch-field select,.dsch-field textarea', { boxSizing: 'border-box', width: '100%', padding: '9px 10px', border: `1px solid ${border}`, borderRadius: '10px', background: layer1, color: 'inherit', font: 'inherit', fontSize: '13px', outline: 'none' }),
  c('.dsch-field input:focus-visible,.dsch-field select:focus-visible,.dsch-field textarea:focus-visible', { borderColor: business, boxShadow: `0 0 0 2px color-mix(in srgb,${business} 18%,transparent)` }),
  c('.dsch-field textarea', { minHeight: '120px', resize: 'vertical', lineHeight: '1.55' }),
  c('.dsch-inline', { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }),
  c('.dsch-inline .dsch-select', { flex: '1', minWidth: '120px' }),
  c('.dsch-select--auto', { flex: 'none', width: 'auto', minWidth: '120px' }),
  c('.dsch-composer', { display: 'flex', gap: '8px', alignItems: 'stretch', marginTop: '2px' }),
  c('.dsch-composer .dsch-select', { flex: '1', minWidth: '0' }),
  c('.dsch-dialogFooter', { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }),
])

export function mountSchedulerStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  if (cssr.find(STYLE_ID) !== null)
    return () => {}
  styles.mount({ id: STYLE_ID, head: true })
  return () => styles.unmount({ id: STYLE_ID })
}
