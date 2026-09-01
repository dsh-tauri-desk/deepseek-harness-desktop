/** CSS generated as css-render nodes so every declaration remains structured. */
import { CssRender } from 'dsh-tauri/client'
import { PANEL_DATA_ATTRIBUTES, PANEL_STYLE_ID } from '../constants'

const cssr = CssRender()
const { c } = cssr

const panelStyle = c([
  c('.dshp-sectionHeader', {
    boxSizing: 'border-box',
    height: '36px',
    color: 'var(--dsw-alias-label-tertiary)',
    borderRadius: '12px',
    flex: 'none',
    alignItems: 'center',
    gap: '4px',
    marginBottom: '4px',
    paddingLeft: '8px',
    display: 'flex',
    overflow: 'hidden',
  }),
  c('.dshp-sectionHeaderTitle', {
    whiteSpace: 'nowrap',
    opacity: 1,
    visibility: 'visible',
    minWidth: 0,
    maxWidth: '45%',
    transition: 'max-width .18s var(--ds-ease-in-out), margin-right .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out), transform .18s var(--ds-ease-in-out), visibility 0s linear',
    flex: 'none',
    lineHeight: '20px',
    overflow: 'hidden',
  }),
  c('.dshp-collapsed .dshp-sectionHeaderTitle', { opacity: 0, visibility: 'hidden', maxWidth: 0 }),
  c('.dshp-root', {
    '--dshp-padding': '12px',
    'height': '100%',
    'padding': '6px var(--dshp-padding)',
    'boxSizing': 'border-box',
    'background': 'var(--dsw-specific-sidebar-fill)',
    'color': 'var(--dsw-alias-label-primary)',
    '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
    '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
    'flexDirection': 'column',
    'fontSize': '14px',
    'display': 'flex',
    '--dsh-sidebar-inline-padding': 'var(--dshp-padding)',
  }),
  c('.dshp-root.dshp-collapsed', { padding: '18px 10px 6px' }),
  c('.dshp-root.dshp-wide', { width: 'var(--dshp-width)' }),
  c('.dshp-root.dshp-quietBars', { '--dsh-scrollbar-thumb': 'transparent', '--dsh-scrollbar-thumb-hover': 'transparent' }),
  c('.dshp-fading>*', { opacity: 0, transition: 'opacity .15s var(--ds-ease-in-out)' }),
  c('.dshp-logoRow', { boxSizing: 'border-box', flex: 'none', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', height: '60px', marginBottom: '4px', padding: '4px 0 4px 4px', display: 'flex', overflow: 'hidden' }),
  c('.dshp-collapsed .dshp-logoRow', { justifyContent: 'flex-start', height: '40px', marginBottom: '4px', padding: 0 }),
  c('.dshp-brand', { minWidth: 0, color: 'inherit', cursor: 'pointer', background: 'transparent', border: 'none', flex: 1, alignItems: 'center', padding: 0, display: 'inline-flex', overflow: 'hidden' }),
  c('.dshp-brandIdentity', { alignItems: 'center', gap: '8px', minWidth: 0, height: '24px', display: 'inline-flex' }),
  c('.dshp-brandMark', { flex: 'none', justifyContent: 'center', alignItems: 'center', display: 'inline-flex' }),
  c('.dshp-brandName', { letterSpacing: '.04em', alignItems: 'center', gap: '6px', minWidth: 0, height: '24px', fontSize: '18px', fontWeight: 600, lineHeight: '24px', display: 'inline-flex' }),
  c('.dshp-fallbackBrandName', { letterSpacing: 0, whiteSpace: 'nowrap', fontSize: '17px' }),
  c('.dshp-iconButton', { cursor: 'pointer', width: '28px', height: '28px', color: 'var(--dsw-alias-label-secondary)', background: 'transparent', border: 'none', borderRadius: '50%', flex: 'none', justifyContent: 'center', alignItems: 'center', padding: 0, display: 'inline-flex' }, [c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover)' })]),
  c('.dshp-collapsed .dshp-iconButton', { width: '36px', height: '36px', color: 'var(--dsw-alias-label-primary)' }),
  c('.dshp-railMark', { justifyContent: 'center', alignItems: 'center', display: 'inline-flex' }),
  c('.dshp-panelArea', { flex: 'none', flexDirection: 'column', alignItems: 'stretch', gap: '2px', margin: 0, display: 'flex', marginRight: 'var(--dsh-session-list-scrollbar-offset)', paddingLeft: '4px', paddingRight: 'calc(var(--dsh-session-list-edge-inset) - var(--dsh-session-list-scrollbar-width) - var(--dsh-session-list-scrollbar-offset))' }),
  c('.dshp-collapsed .dshp-panelArea', { alignItems: 'center', gap: '4px' }),
  c('.dshp-menuItem', {
    boxSizing: 'border-box',
    appearance: 'none',
    cursor: 'pointer',
    userSelect: 'none',
    width: '100%',
    minWidth: 0,
    height: '34px',
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 8px',
    border: 0,
    borderRadius: '8px',
    overflow: 'hidden',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'inherit',
    fontSize: '14px',
    fontWeight: 400,
    lineHeight: '22px',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    transition: 'background-color .12s var(--ds-ease-in-out), color .12s var(--ds-ease-in-out)',
  }, [c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover)' }), c('&:focus-visible', { outline: '2px solid var(--dsw-alias-border-focus)', outlineOffset: '-2px' })]),
  c('.dshp-menuItemSelected,.dshp-menuItemSelected:hover', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
  c('.dshp-newSession', { width: '100%', height: '38px', margin: '0 0 4px', padding: '8px 16px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', background: 'var(--dsw-alias-button-elevated-fill)', justifyContent: 'center', alignItems: 'center', gap: '6px', fontWeight: 500 }, [c('&:hover', { background: 'var(--dsw-alias-button-floating-hover)' })]),
  c('.dshp-menuItemIcon', {
    boxSizing: 'border-box',
    flex: 'none',
    justifyContent: 'center',
    alignItems: 'center',
    display: 'inline-flex',
    fontSize: '16px',
  }),
  c('.dshp-menuItemLabel', { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '0 6px 0 0' }),
  c('.dshp-collapsed .dshp-menuItem', { justifyContent: 'center', alignSelf: 'flex-start', width: '36px', minWidth: '36px', height: '36px', padding: 0, gap: 0, borderRadius: '12px' }),
  c('.dshp-collapsed .dshp-menuItemLabel', { display: 'none' }),
  c('.dshp-collapsed .dshp-panelArea', { marginBottom: '12px', paddingLeft: 0 }),
  c('.dshp-collapsed .dshp-menuItemIcon', {
    fontSize: '18px',
    color: 'var(--dsw-alias-label-primary)',
  }),
  c('.dshp-collapsed .dshp-newSession', { borderColor: 'transparent', justifyContent: 'center', width: '36px', height: '36px', margin: 0, padding: 0, gap: 0 }),
  c('.dshp-regionArea', { minHeight: 0, marginRight: 'calc(-1 * var(--dshp-padding))', flexDirection: 'column', flex: 1, padding: '0 4px', display: 'flex', overflow: 'hidden' }),
  c('.dshp-collapsed .dshp-regionArea', { marginLeft: 0, marginRight: 0, padding: 0 }),
  c('.dshp-footArea', { flexDirection: 'column', flex: 'none', display: 'flex' }),
  c('.dshp-settingsArea,.dshp-footerActions', { flex: 'none', width: '100%', minWidth: 0 }),
  c('.dshp-footerActions', { display: 'flex' }),
  c('.dshp-collapsed .dshp-footArea', { alignItems: 'center' }),
  c('.dshp-collapsed .dshp-settingsArea,.dshp-collapsed .dshp-footerActions', { justifyContent: 'center', width: 'auto', display: 'flex' }),
  c('.dshp-panelView', {
    'height': '100%',
    'boxSizing': 'border-box',
    'minWidth': 0,
    'overflowY': 'auto',
    'scrollbarGutter': 'stable',
    'position': 'relative',
    // 内容宽度派生（自给自足镜像 alpha）：有拖拽偏好用偏好，否则自适应
    // clamp(680px, col*0.64, 920px)；列宽与偏好由 width 控制器发布。
    '--dsh-chat-content-width': 'var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * .64), 920px))',
  }),
  c('.dshp-panelViewColumn', { maxWidth: 'var(--dsh-chat-content-width,780px)', minHeight: '100%', width: '100%', margin: '0 auto', flexDirection: 'column', gap: '16px', display: 'flex' }),
  // 内容宽度拖拽手柄（镜像 alpha WidthHandle）：绝对定位在内容列两侧 24px 外，
  // 宽度自适应（列宽 − 内容宽的一半再减两个 24px inset，最多 40px）；
  // hover/拖动时发光条跟随指针 Y（--dsh-width-handle-pointer-y）。
  c('.dshp-widthHandle', {
    zIndex: 8,
    width: 'min(40px, calc((100% - var(--dsh-chat-content-width)) / 2 - 24px - 24px))',
    cursor: 'col-resize',
    position: 'absolute',
    top: 0,
    bottom: 0,
  }),
  c('.dshp-widthHandle[data-side="left"]', { right: 'calc(50% + var(--dsh-chat-content-width) / 2 + 24px)' }),
  c('.dshp-widthHandle[data-side="right"]', { left: 'calc(50% + var(--dsh-chat-content-width) / 2 + 24px)' }),
  c('.dshp-widthHandle:after', {
    content: '""',
    background: 'linear-gradient(to bottom, transparent calc(var(--dsh-width-handle-pointer-y, 50%) - 52px), var(--dsw-alias-scrollbar-hover-l1) calc(var(--dsh-width-handle-pointer-y, 50%) - 12px), var(--dsw-alias-scrollbar-hover-l1) calc(var(--dsh-width-handle-pointer-y, 50%) + 12px), transparent calc(var(--dsh-width-handle-pointer-y, 50%) + 52px))',
    opacity: 0,
    pointerEvents: 'none',
    borderRadius: '3px',
    width: '3px',
    position: 'absolute',
    top: 0,
    bottom: 0,
  }),
  c('.dshp-widthHandle[data-side="left"]:after', { right: '16px' }),
  c('.dshp-widthHandle[data-side="right"]:after', { left: '16px' }),
  c('.dshp-widthHandle:hover:after,.dshp-widthHandle[data-dragging]:after', { opacity: 1 }),
  // 面板激活期间，侧栏工作区单项撤销 hover 底色（仅非选中行；选中行保留
  // 自己的选中态，避免点按目标不可辨）。语义选择器按官方 aria 状态匹配，
  // 不依赖 css-module hash。
  c(`[${PANEL_DATA_ATTRIBUTES.active}] [role="treeitem"]:not([aria-selected="true"]):hover`, { background: 'transparent' }),
  c('@keyframes dshp-rail-in', [c('from', { opacity: 0, transform: 'translate(49px)' })]),
  c('@keyframes dshp-rail-fade-in', [c('from', { opacity: 0 })]),
  c('@media (prefers-reduced-motion: reduce)', [c('.dshp-fading>*', { transition: 'none' }), c('.dshp-railIn .dshp-iconButton,.dshp-railIn .dshp-menuItem,.dshp-railIn .dshp-footArea,.dshp-railIn .dshp-regionArea', { animation: 'none' })]),
])

export function mountPanelStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  if (cssr.find(PANEL_STYLE_ID) !== null)
    return () => {}
  panelStyle.mount({ id: PANEL_STYLE_ID, head: true })
  return () => panelStyle.unmount({ id: PANEL_STYLE_ID })
}
