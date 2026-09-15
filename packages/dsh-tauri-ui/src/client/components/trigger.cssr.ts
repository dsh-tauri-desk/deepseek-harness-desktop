import { styles as sharedStyles } from '../constants/theme'
import { cssr } from '../utils/cssr'

const { c, bem: { b, m } } = cssr
const { primary, hover } = sharedStyles

export default b('settings-trigger', {
  boxSizing: 'border-box',
  cursor: 'pointer',
  width: 'calc(100% + 4px)',
  height: '42px',
  color: primary,
  background: 'none',
  border: 'none',
  borderRadius: '12px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  margin: '4px -2px',
  padding: '0 10px 0 8px',
  fontFamily: 'inherit',
  fontSize: '14px',
  lineHeight: '22px',
  overflow: 'hidden',
  flex: 'none',
}, [
  c('&:hover', { background: hover }),
  m('rail', {
    borderRadius: '50%',
    justifyContent: 'center',
    gap: 0,
    width: '36px',
    height: '36px',
    margin: '8px 0 10px',
    padding: 0,
  }),
])
