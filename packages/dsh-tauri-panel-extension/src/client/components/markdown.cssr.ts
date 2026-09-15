import { cssr, styles as sharedStyles } from 'dsh-tauri-ui/client'

const { c, bem: { b, e } } = cssr
const { primary, borderL2: border, business, layer1, layer3 } = sharedStyles

export default b('extension', [
  e('md-preview', {
    minHeight: '320px',
    maxHeight: '60vh',
    overflowY: 'auto',
    border: `1px solid ${border}`,
    borderRadius: '8px',
    padding: '8px 12px',
    background: layer1,
    fontSize: '13px',
  }),
  e('md-body', [
    c('& h1, & h2, & h3, & h4', { margin: '14px 0 6px', color: primary, lineHeight: '1.4' }),
    c('& h1', { fontSize: '18px' }),
    c('& h2', { fontSize: '16px' }),
    c('& h3', { fontSize: '14px' }),
    c('& h4', { fontSize: '13px' }),
    c('& p', { margin: '6px 0', lineHeight: '20px' }),
    c('& ul, & ol', { margin: '6px 0', paddingLeft: '20px' }),
    c('& code', {
      fontFamily: 'var(--ds-font-family-code)',
      fontSize: '12px',
      background: layer3,
      borderRadius: '4px',
      padding: '1px 5px',
    }),
    c('& pre', {
      margin: '8px 0',
      padding: '10px 12px',
      overflowX: 'auto',
      border: `1px solid ${border}`,
      borderRadius: '8px',
      background: layer3,
    }),
    c('& a', { color: business }),
  ]),
])
