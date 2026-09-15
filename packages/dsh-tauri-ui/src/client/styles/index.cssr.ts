import { TURN_NAVIGATION_NARROW_SELECTOR } from '../constants'
import { cssr } from '../utils/cssr'

const { c } = cssr

export default c(TURN_NAVIGATION_NARROW_SELECTOR, {
  position: 'fixed',
  top: 'max(32px, calc((100dvh - var(--dsh-composer-height, 152px)) / 2))',
  right: 'max(8px, env(safe-area-inset-right, 0px))',
  zIndex: 30,
  width: '28px',
  height: 'min(var(--turn-natural-height, 32px), max(32px, calc(100dvh - var(--dsh-composer-height, 152px) - 32px)), 420px)',
  maxHeight: 'calc(100dvh - 32px)',
  minHeight: '32px',
  visibility: 'visible',
  opacity: 1,
  transform: 'translateY(-50%)',
})
