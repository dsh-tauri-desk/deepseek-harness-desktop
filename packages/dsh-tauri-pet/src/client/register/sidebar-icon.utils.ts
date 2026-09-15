import {
  PET_ICON_ATTRIBUTE,
  PET_SETTINGS_ROW_CLASS,
  SETTINGS_TRIGGER_RAIL_CLASS,
} from '../constants'

/** 入口图标（爪印，currentColor 跟随官方 iconButton 悬停变色）。 */
const PET_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 13.5c-2.7 0-5.5 2-5.5 4.3 0 1.4 1 2.2 2.3 2.2 1 0 1.9-.6 3.2-.6s2.2.6 3.2.6c1.3 0 2.3-.8 2.3-2.2 0-2.3-2.8-4.3-5.5-4.3z"/><path d="M7.3 8.1c-1 .1-1.8 1.2-1.7 2.5.1 1.2 1 2.1 2 2 .9-.1 1.7-1.2 1.6-2.4-.1-1.2-1-2.2-1.9-2.1z"/><path d="M12 4.5c-1.1 0-2 1.1-2 2.5s.9 2.5 2 2.5 2-1.1 2-2.5-.9-2.5-2-2.5z"/><path d="M16.7 8.1c-.9-.1-1.8.9-1.9 2.1-.1 1.2.7 2.3 1.6 2.4 1 .1 1.9-.8 2-2 .1-1.3-.7-2.4-1.7-2.5z"/><path d="M4.8 12.3c-.8.3-1.2 1.4-.9 2.4.3 1 1.2 1.6 2 1.3.8-.3 1.1-1.4.8-2.4-.3-1-1.1-1.6-1.9-1.3z"/><path d="M19.2 12.3c-.8-.3-1.6.3-1.9 1.3-.3 1 0 2.1.8 2.4.8.3 1.7-.3 2-1.3.3-1-.1-2.1-.9-2.4z"/></svg>'

/** 创建入口按钮（绿点常驻 DOM，用 aria-pressed + 类名表达两态）。 */
export function createIconButton(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dshp-pet__icon-button'
  button.setAttribute(PET_ICON_ATTRIBUTE, '1')
  button.setAttribute('data-tip', label)
  button.setAttribute('aria-label', label)
  button.innerHTML = `${PET_ICON_SVG}<span class="dshp-pet__icon-dot" aria-hidden="true" />`
  return button
}

/** 按共享状态同步按钮两态（绿点显隐 + aria-pressed）：绿点 = 宠物已开启。 */
export function syncIconState(button: HTMLButtonElement, active: boolean): void {
  button.classList.toggle('dshp-pet__icon--on', active)
  button.setAttribute('aria-pressed', String(active))
}

/** 触发器是否处于折叠态（Rail 圆形按钮）：折叠态保持定宽，不做拉伸修正。 */
export function isRailTrigger(trigger: HTMLElement): boolean {
  return trigger.classList.contains(SETTINGS_TRIGGER_RAIL_CLASS)
}

/**
 * 把触发器宿主立成 flex 行（复刻新版 dsh 客户端 SettingsRoot 的 triggerRow）。
 *
 * 除行类 + CSS 规则外再写一份内联样式兜底：CSS 可能被加载顺序/特异性盖过（表现为图标
 * 仍被挤到下一行），而 React 对未声明 style 的节点不会清除外部内联样式。
 */
export function applySettingsRow(host: HTMLElement, trigger: HTMLElement, rail: boolean): void {
  host.classList.add(PET_SETTINGS_ROW_CLASS)
  host.style.display = 'flex'
  host.style.alignItems = 'center'
  host.style.gap = '8px'
  host.style.width = '100%'
  if (rail) {
    trigger.style.removeProperty('flex')
    trigger.style.removeProperty('width')
    trigger.style.removeProperty('min-width')
    return
  }
  trigger.style.flex = '1 1 auto'
  trigger.style.width = 'auto'
  trigger.style.minWidth = '0'
}

/** 撤销设置行的类与内联样式（卸载时；未打过补丁的节点原样返回）。 */
export function revertSettingsRow(host: HTMLElement | undefined, trigger: HTMLElement | undefined): void {
  if (host) {
    host.classList.remove(PET_SETTINGS_ROW_CLASS)
    host.style.removeProperty('display')
    host.style.removeProperty('align-items')
    host.style.removeProperty('gap')
    host.style.removeProperty('width')
  }
  if (!trigger)
    return
  trigger.style.removeProperty('flex')
  trigger.style.removeProperty('width')
  trigger.style.removeProperty('min-width')
}
