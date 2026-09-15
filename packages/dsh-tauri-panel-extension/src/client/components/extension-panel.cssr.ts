import { cssr, panelContainer, styles as sharedStyles } from 'dsh-tauri-ui/client'

const { c, bem: { b, e } } = cssr
const { primary, tertiary, borderL2: border, business } = sharedStyles

export default b('extension', [
  e('section', {
    ...panelContainer,
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    color: primary,
  }),
  e('tabs', {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '22px',
    borderBottom: `1px solid ${border}`,
    marginTop: '2px',
  }),
  e('tab', {
    position: 'relative',
    border: '0',
    padding: '7px 1px 9px',
    background: 'transparent',
    color: tertiary,
    font: 'inherit',
    fontSize: '13px',
    lineHeight: '20px',
    cursor: 'pointer',
  }, [
    c('&:hover, &[data-active="true"]', { color: primary }),
    c('&[data-active="true"]::after, &:focus-visible::after', {
      position: 'absolute',
      right: '0',
      bottom: '-1px',
      left: '0',
      height: '2px',
      borderRadius: '2px 2px 0 0',
      background: primary,
      content: '""',
    }),
    c('&:focus-visible', {
      outline: `2px solid ${business}`,
      outlineOffset: '2px',
      borderRadius: '2px',
      color: primary,
    }),
  ]),
  e('tab-panel', { minWidth: '0', paddingTop: '2px' }),
])
