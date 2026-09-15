import { cssr, panelContainer, styles as sharedStyles } from 'dsh-tauri-ui/client'

const { c } = cssr
const { primary, secondary, tertiary, borderL2: border, font } = sharedStyles

/** 定时任务面板主容器（scheduler-panel.tsx）：外壳 + 搜索 + Tabs。 */
export default c([
  c('.dshp-scheduler__shell', { ...panelContainer, paddingBlock: '24px 32px', color: primary, fontFamily: font, fontSize: '13px', lineHeight: '1.5' }),
  c('.dshp-scheduler__top', { display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '12px' }),
  c('.dshp-scheduler__heading h1', { margin: '0', fontSize: '20px', lineHeight: '28px', fontWeight: '650', letterSpacing: '-.2px' }),
  c('.dshp-scheduler__heading p', { margin: '4px 0 0', color: tertiary, fontSize: '13px', lineHeight: '1.5' }),
  c('.dshp-scheduler__toolbar', { display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: '8px' }),
  c('.dshp-scheduler__toolbar-spacer', { flex: '1' }),
  c('.dshp-scheduler__search-wrap', { position: 'relative', display: 'inline-flex', flex: '1', minWidth: '0', maxWidth: '280px' }),
  c('.dshp-scheduler__search-wrap .dshp-scheduler__input', { width: '100%', paddingLeft: '32px' }),
  c('.dshp-scheduler__search-icon', { position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: tertiary }),
  c('.dshp-scheduler__tabs', { display: 'flex', alignItems: 'center', gap: '16px', margin: '4px 0 14px', borderBottom: `1px solid ${border}` }),
  c('.dshp-scheduler__tab', { padding: '8px 0', border: '0', borderBottom: '2px solid transparent', background: 'transparent', color: secondary, font: 'inherit', fontSize: '13px', cursor: 'pointer' }),
  c('.dshp-scheduler__tab:hover', { color: primary }),
  c('.dshp-scheduler__tab--active', { borderBottomColor: 'currentColor', color: primary, fontWeight: '650' }),
  c('.dshp-scheduler__cards', { display: 'flex', flexDirection: 'column', gap: '8px', margin: '0', padding: '0', listStyle: 'none' }),
  c('.dshp-scheduler__empty', { margin: '0', padding: '48px 0', color: tertiary, fontSize: '13px', textAlign: 'center' }),
  c('.dshp-scheduler__error', { color: 'var(--dsw-alias-state-error-primary)', margin: '0', fontSize: '12px', lineHeight: '18px' }),
  c('@media (max-width: 680px)', [c('.dshp-scheduler__search-wrap', { maxWidth: '160px' })]),
])
