import { cssr } from 'dsh-tauri-ui/client'
import { SESSION_ICON_ATTRIBUTE } from '../constants'

const { c } = cssr

export default c([
  c(`[${SESSION_ICON_ATTRIBUTE}]`, {
    width: '16px',
    height: '20px',
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: '2px',
    color: 'var(--dsw-alias-label-secondary)',
  }),
  c('[role="treeitem"]', { position: 'relative' }),
])
