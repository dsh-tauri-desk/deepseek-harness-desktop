/** Placeholder styles generated as structured css-render nodes. */
import { CssRender } from 'dsh-tauri/client'
import { PLACEHOLDER_CENTER_CLASS, PLACEHOLDER_TEXT_CLASS, STYLE_ID } from './constants'

const cssr = CssRender()
const { c } = cssr

const placeholderStyle = c([
  c(`.${PLACEHOLDER_CENTER_CLASS}`, {
    boxSizing: 'border-box',
    minHeight: '100%',
    color: 'var(--dsw-alias-label-primary)',
    alignItems: 'center',
    justifyContent: 'center',
    display: 'flex',
  }),
  c(`.${PLACEHOLDER_TEXT_CLASS}`, {
    fontSize: '15px',
    color: 'var(--dsw-alias-label-secondary)',
    userSelect: 'none',
  }),
])

/** Mount placeholder styles through css-render and return an unmount disposer. */
export function mountPlaceholderStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  if (cssr.find(STYLE_ID) !== null)
    return () => {}
  placeholderStyle.mount({ id: STYLE_ID, head: true })
  return () => placeholderStyle.unmount({ id: STYLE_ID })
}
