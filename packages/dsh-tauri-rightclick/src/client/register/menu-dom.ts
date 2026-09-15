import type { MenuItemOptions } from './context-menu.types'
import { clamp } from 'dsh-tauri/client'
import {
  MENU_BLOCK,
  MENU_ITEM_CLASS,
  MENU_ITEM_DANGER_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SHORTCUT_CLASS,
  MENU_VIEWPORT_MARGIN,
} from '../constants'

export function createMenuRoot(): HTMLDivElement {
  const root = document.createElement('div')
  root.className = MENU_BLOCK
  root.setAttribute('role', 'menu')
  root.style.visibility = 'hidden'
  return root
}

export function createMenuItem(options: MenuItemOptions): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = options.danger ? `${MENU_ITEM_CLASS} ${MENU_ITEM_DANGER_CLASS}` : MENU_ITEM_CLASS
  button.setAttribute('role', 'menuitem')
  button.tabIndex = -1
  const label = document.createElement('span')
  label.textContent = options.label
  button.appendChild(label)
  if (options.shortcut) {
    const hint = document.createElement('span')
    hint.className = MENU_SHORTCUT_CLASS
    hint.textContent = options.shortcut
    button.appendChild(hint)
  }
  button.onclick = () => {
    options.onClick()
  }
  return button
}

export function createSeparator(): HTMLDivElement {
  const node = document.createElement('div')
  node.className = MENU_SEPARATOR_CLASS
  node.setAttribute('role', 'separator')
  return node
}

/** 限制在视口内（最小边距 6px），定位后显示并聚焦首个菜单项。 */
export function positionMenu(root: HTMLElement, x: number, y: number): void {
  const rect = root.getBoundingClientRect()
  root.style.left = `${clamp(x, MENU_VIEWPORT_MARGIN, innerWidth - rect.width - MENU_VIEWPORT_MARGIN)}px`
  root.style.top = `${clamp(y, MENU_VIEWPORT_MARGIN, innerHeight - rect.height - MENU_VIEWPORT_MARGIN)}px`
  root.style.visibility = 'visible'
  root.querySelector('button')?.focus()
}
