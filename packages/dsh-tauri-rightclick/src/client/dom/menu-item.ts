/**
 * dom/menu-item.ts — 右键菜单的纯 DOM 构建：菜单根 / 菜单项 / 分隔线 / 视口内定位。
 *
 * 与菜单装配逻辑分离：本文件只负责「给定选项，产出稳定无障碍语义的 DOM 节点」，
 * 不含 close/toast/错误处理等控制器职责（那些留在 menu.ts 的 add/split 包装里）。
 * 全部基于稳定的 role / class 语义，不依赖生成哈希的 CSS module 类名。
 */
import { RIGHTCLICK_CLASSES as K, MENU_VIEWPORT_MARGIN } from '../constants'

/** 菜单项构建选项（danger 决定危险样式；shortcut 显示右侧快捷键提示）。 */
export interface MenuItemOptions {
  label: string
  shortcut?: string
  danger?: boolean
  onClick: () => void | Promise<void>
}

/** 创建菜单根节点（初始隐藏，定位后由 positionMenu 显隐）。 */
export function createMenuRoot(): HTMLDivElement {
  const root = document.createElement('div')
  root.className = K.menu
  root.setAttribute('role', 'menu')
  root.style.visibility = 'hidden'
  return root
}

/** 创建单个菜单项按钮（role=menuitem，含 label 与可选快捷键提示）。 */
export function createMenuItem(options: MenuItemOptions): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = options.danger ? `${K.item} ${K.itemDanger}` : K.item
  button.setAttribute('role', 'menuitem')
  button.tabIndex = -1
  const itemLabel = document.createElement('span')
  itemLabel.textContent = options.label
  button.appendChild(itemLabel)
  if (options.shortcut) {
    const hint = document.createElement('span')
    hint.className = K.shortcut
    hint.textContent = options.shortcut
    button.appendChild(hint)
  }
  button.onclick = () => {
    options.onClick()
  }
  return button
}

/** 创建菜单分隔线（role=separator）。 */
export function createSeparator(): HTMLDivElement {
  const node = document.createElement('div')
  node.className = K.separator
  node.setAttribute('role', 'separator')
  return node
}

/**
 * 菜单定位：限制在视口内（最小边距 6px），定位后显示并聚焦首个菜单项。
 * @param root - 已挂载到 body 的菜单根节点。
 * @param x - 触发事件 clientX。
 * @param y - 触发事件 clientY。
 */
export function positionMenu(root: HTMLElement, x: number, y: number): void {
  const rect = root.getBoundingClientRect()
  root.style.left = `${Math.max(MENU_VIEWPORT_MARGIN, Math.min(x, innerWidth - rect.width - MENU_VIEWPORT_MARGIN))}px`
  root.style.top = `${Math.max(MENU_VIEWPORT_MARGIN, Math.min(y, innerHeight - rect.height - MENU_VIEWPORT_MARGIN))}px`
  root.style.visibility = 'visible'
  root.querySelector('button')?.focus()
}
