import { TURN_NAVIGATION_NARROW_SELECTOR } from '../constants'
import { cssr } from '../utils/cssr'

const { c } = cssr

/**
 * 轮次导航窄栏常驻（纯样式，无组件面）。
 * The core rail is inside the conversation column. That column is clipped,
 * and the core height can resolve to 0 when the available composer band is
 * tight. Only apply the viewport anchor while the shell reports a collapsed
 * sidebar; the core's inner scroller and mark geometry remain untouched.
 */
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
