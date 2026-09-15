import { cssr, styles as sharedStyles } from 'dsh-tauri-ui/client'

const { c, bem: { b, e } } = cssr
const { primary, tertiary, borderL2: border, business } = sharedStyles

export default b('extension', [
  e('editor-tabs', { display: 'flex', gap: '4px', borderBottom: `1px solid ${border}` }),
  e('editor-tab', {
    position: 'relative',
    border: '0',
    padding: '7px 10px 9px',
    background: 'transparent',
    color: tertiary,
    font: 'inherit',
    fontSize: '13px',
    lineHeight: '20px',
    cursor: 'pointer',
  }, [
    c('&:hover, &[data-active="true"]', { color: primary }),
    c('&[data-active="true"]::after', {
      position: 'absolute',
      right: '8px',
      bottom: '-1px',
      left: '8px',
      height: '2px',
      borderRadius: '2px 2px 0 0',
      background: primary,
      content: '""',
    }),
    c('&:focus-visible', {
      outline: `2px solid ${business}`,
      outlineOffset: '-2px',
      borderRadius: '4px',
      color: primary,
    }),
  ]),
  e('json-editor', { minHeight: '260px' }),
])
