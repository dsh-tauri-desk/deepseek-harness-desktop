/** Settings UI styles generated as css-render nodes. */
import { CssRender } from 'dsh-tauri/client'
import { SETTINGS_STYLE_ID } from './constants'

const cssr = CssRender()
const { c } = cssr

const settingsStyle = c([
  c('.dsh-tu-settingsTrigger', {
    boxSizing: 'border-box',
    cursor: 'pointer',
    width: 'calc(100% + 4px)',
    height: '42px',
    color: 'var(--dsw-alias-label-primary)',
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
    c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
  ]),
  c('.dsh-tu-settingsTriggerRail', {
    borderRadius: '50%',
    justifyContent: 'center',
    gap: 0,
    width: '36px',
    height: '36px',
    margin: '8px 0 10px',
    padding: 0,
  }),
  c('.dsh-tu-settingsRoot', {
    '--dsh-chat-content-width': '748px',
    '--dsh-composer-card-max-width': 'calc(var(--dsh-chat-content-width) + 32px)',
    '--dsh-composer-side-clearance': '16px',
    'position': 'fixed',
    'inset': 0,
    'zIndex': 1000,
    'display': 'flex',
    'background': 'var(--dsw-alias-bg-base)',
    'color': 'var(--dsw-alias-label-primary)',
  }),
  c('.dsh-tu-settingsRail', {
    flex: 'none',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    width: 'var(--dsh-settings-rail-width)',
    padding: '6px 12px',
    background: 'var(--dsw-specific-sidebar-fill)',
    borderRight: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
    overflow: 'hidden',
  }),
  c('.dsh-tu-settingsBack', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    alignSelf: 'flex-start',
    padding: '6px 10px',
    border: 'none',
    background: 'none',
    borderRadius: '10px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    width: '100%',
    fontSize: '14px',
    lineHeight: '22px',
    color: 'var(--dsw-alias-label-primary)',
  }, [
    c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
  ]),
  c('.dsh-tu-settingsSearch', {
    width: '100%',
    height: '36px',
    boxSizing: 'border-box',
    padding: '0 10px',
    borderRadius: '10px',
    border: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.25))',
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'inherit',
    fontSize: '14px',
    outline: 'none',
  }),
  c('.dsh-tu-settingsNav', {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    flex: 1,
    overflowY: 'auto',
    minHeight: 0,
  }),
  c('.dsh-tu-settingsNavItem', {
    boxSizing: 'border-box',
    height: '40px',
    padding: '9px 12px',
    border: 'none',
    background: 'none',
    borderRadius: '12px',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '14px',
    lineHeight: '22px',
    fontWeight: 400,
    color: 'var(--dsw-alias-label-primary)',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  }),
  c('.dsh-tu-settingsNavIcon', {
    flex: 'none',
  }),
  c('.dsh-tu-settingsNavLabel', {
    flex: 1,
    minWidth: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }),
  c('.dsh-tu-settingsNavItemActive', {
    background: 'var(--dsw-specific-sidebar-nav-item-active)',
    fontWeight: 500,
  }),
  c('.dsh-tu-settingsEmpty', {
    padding: '12px 10px',
    fontSize: '13px',
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  c('.dsh-tu-settingsHandle', {
    flex: 'none',
    alignSelf: 'stretch',
    width: '8px',
    marginLeft: '-4px',
    zIndex: 2,
    cursor: 'col-resize',
    touchAction: 'none',
    background: 'transparent',
    borderRadius: '4px',
  }),
  c('.dsh-tu-settingsHandleDragging', {
    background: 'var(--dsw-alias-border-l2)',
  }),
  c('.dsh-tu-settingsContentOuter', {
    flex: 1,
    minWidth: 0,
    height: '100%',
    boxSizing: 'border-box',
    overflowY: 'auto',
    display: 'flex',
  }),
  c('.dsh-tu-settingsContentInner', {
    width: 'min(calc(var(--dsh-composer-card-max-width) + 2 * var(--dsh-composer-side-clearance)), 100%)',
    margin: '0 auto',
    boxSizing: 'border-box',
    padding: '28px 36px',
  }),
])

export function mountSettingsStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  if (cssr.find(SETTINGS_STYLE_ID) !== null)
    return () => {}
  settingsStyle.mount({ id: SETTINGS_STYLE_ID, head: true })
  return () => settingsStyle.unmount({ id: SETTINGS_STYLE_ID })
}
