import { cssr, styles as sharedStyles } from 'dsh-tauri-ui/client'

const { c, bem: { b, e } } = cssr
const { primary, borderL2: border, business, layer1 } = sharedStyles

export default b('extension', [
  e('scope', {
    boxSizing: 'border-box',
    border: `1px solid ${border}`,
    borderRadius: '8px',
    padding: '4px 10px',
    outline: 'none',
    background: layer1,
    color: primary,
    font: 'inherit',
    fontSize: '12px',
    lineHeight: '18px',
  }, [
    c('&:focus-visible', {
      borderColor: business,
      boxShadow: `0 0 0 2px color-mix(in srgb,${business} 18%,transparent)`,
    }),
  ]),
])
