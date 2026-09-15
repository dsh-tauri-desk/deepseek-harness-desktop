import { styles as sharedStyles } from '../constants/theme'
import { cssr } from '../utils/cssr'

const { c, bem: { b, m } } = cssr
const { primary, secondary, hover, modulePlatform } = sharedStyles

export default b('menu-select', {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '10px',
  minHeight: '36px',
  padding: '0 14px',
  border: 'none',
  borderRadius: '18px',
  background: modulePlatform,
  color: primary,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '14px',
  lineHeight: '22px',
  whiteSpace: 'nowrap',
}, [
  c('&:hover', { background: hover }),
  c('& > span', {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }),
  c('& > svg', { flex: 'none' }),
  m('pill', {
    minHeight: '28px',
    height: '28px',
    padding: '0 8px',
    borderRadius: '8px',
    background: 'transparent',
    color: secondary,
    fontSize: '13px',
    fontWeight: '500',
    gap: '6px',
  }, [
    c('&:hover', {
      background: hover,
      color: primary,
    }),
  ]),
])
