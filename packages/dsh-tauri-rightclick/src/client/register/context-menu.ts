import type { ClientContext } from 'dsh-tauri/client'
import type { ActionOutcome, SessionsRuntimeLike, WorkspacesRuntimeLike } from '../types'
import type { MenuComposer, OfficialSelectOptions } from './context-menu.types'
import { defineRegister } from 'dsh-tauri/client'
import {
  CONTEXT_MENU_EVENT,
  LINK_SELECTOR,
  MENU_ITEM_SELECTOR,
  MENU_SEPARATOR_CLASS,
  TOAST_CLASS,
  TOAST_DURATION_MS,
} from '../constants'
import { locale } from '../locales'
import { loadRegistry } from '../service/registry'
import { writeClipboard } from '../utils/clipboard'
import { selectionSurface } from '../utils/editable'
import {
  buildEditableMenu,
  buildSelectionMenu,
  buildSessionMenu,
  buildUngroupedMenu,
  buildWorkspaceMenu,
} from './context-menu.menu'
import {
  editableFrom,
  officialAction,
  resolveSession,
  rowFrom,
  selectedText,
  ungroupedRowFrom,
  workspaceForSession,
  workspaceFrom,
} from './locate'
import { createMenuItem, createMenuRoot, createSeparator, positionMenu } from './menu-dom'

/**
 * 右键菜单特性：解析右键目标 → 组装菜单 → 动作经 `service/` 收口。
 * 官方会话/工作区操作全部转交官方组件，插件只补充宿主能力与扩展项。
 */
export const contextMenuFeature = defineRegister<ClientContext>((controller, _ctx, adapter) => {
  const sessions = adapter.sessions as unknown as SessionsRuntimeLike
  const workspaces = adapter.workspaces as unknown as WorkspacesRuntimeLike
  const registry = loadRegistry()

  let menu: HTMLElement | null = null

  const close = (): void => {
    menu?.remove()
    menu = null
  }

  const toast = (message: string): void => {
    document.querySelector(`.${TOAST_CLASS}`)?.remove()
    const node = document.createElement('div')
    node.className = TOAST_CLASS
    node.textContent = message
    document.body.appendChild(node)
    controller.timeout(() => node.remove(), TOAST_DURATION_MS)
  }

  const copyText = async (value: string, message: string): Promise<void> => {
    if (!await writeClipboard(value))
      throw new Error(locale.text('clipboardUnavailable'))
    toast(message)
  }

  const createComposer = (root: HTMLElement): MenuComposer => {
    const add = (
      label: string,
      action: () => Promise<ActionOutcome | void> | void,
      shortcut = '',
      danger = false,
    ): void => {
      root.appendChild(createMenuItem({
        label,
        shortcut,
        danger,
        onClick: async () => {
          close()
          try {
            const outcome = await action()
            if (outcome && !outcome.ok)
              toast(outcome.error || locale.text('unknownError'))
          }
          catch (error) {
            toast(error instanceof Error ? error.message : String(error))
          }
        },
      }))
    }

    const split = (): void => {
      if (!root.childElementCount || root.lastElementChild?.classList.contains(MENU_SEPARATOR_CLASS))
        return
      root.appendChild(createSeparator())
    }

    return {
      sessions,
      workspaces,
      add,
      split,
      toast,
      copyText,
      close,
      delegate: (workspace: boolean): OfficialSelectOptions => ({
        workspace,
        schedule: (fn, ms) => controller.timeout(fn, ms),
        onFailure: toast,
      }),
    }
  }

  const onContextMenu = (event: MouseEvent): void => {
    if (event.defaultPrevented)
      return
    const row = rowFrom(event.target)
    const ungroupedRow = !row ? ungroupedRowFrom(event.target) : null
    const domSessionWorkspace = row ? workspaceFrom(event.target, workspaces) : null
    const session = row ? resolveSession(sessions, row, domSessionWorkspace?.workspace ?? null) : null
    // 可见的空白「新会话」只是临时输入目标，不弹菜单。
    if (session?.blank === true)
      return
    const resolvedWorkspace = domSessionWorkspace?.workspace || workspaceForSession(workspaces, session)
    const sessionWorkspace = resolvedWorkspace ? { workspace: resolvedWorkspace } : null
    const workspaceTarget = !row && !ungroupedRow ? workspaceFrom(event.target, workspaces) : null
    const editable = editableFrom(event.target)
    const selection = selectedText(editable).trim()
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(LINK_SELECTOR) : null
    const surface = selectionSurface(event.target)
    if (!row && !ungroupedRow && !workspaceTarget && !editable && !selection && !link && !surface)
      return

    event.preventDefault()
    event.stopPropagation()
    close()
    const root = createMenuRoot()
    document.body.appendChild(root)
    menu = root

    const extensions = registry.list()
    globalThis.dispatchEvent(new CustomEvent(CONTEXT_MENU_EVENT, {
      detail: {
        row: row || ungroupedRow || workspaceTarget?.targetRow || null,
        action: row ? officialAction(row) : null,
        session,
        workspace: workspaceTarget?.workspace || null,
        target: event.target,
        x: event.clientX,
        y: event.clientY,
        extensions,
      },
    }))

    const composer = createComposer(root)
    if (row)
      buildSessionMenu(composer, row, session, sessionWorkspace, extensions)
    else if (ungroupedRow)
      buildUngroupedMenu(composer)
    else if (workspaceTarget)
      buildWorkspaceMenu(composer, workspaceTarget)
    else if (editable)
      buildEditableMenu(composer, editable, selection)
    else
      buildSelectionMenu(composer, selection, link, surface)

    positionMenu(root, event.clientX, event.clientY)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (menu && !menu.contains(event.target as Node))
      close()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!menu)
      return
    if (event.key === 'Escape') {
      close()
      return
    }
    const items = [...menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)]
    const current = items.indexOf(document.activeElement as HTMLElement)
    let next: Element | null = null
    if (event.key === 'ArrowDown')
      next = items[(current + 1 + items.length) % items.length]
    else if (event.key === 'ArrowUp')
      next = items[(current - 1 + items.length) % items.length]
    else if (event.key === 'Home')
      next = items[0]
    else if (event.key === 'End')
      next = items.at(-1) ?? null
    if (next) {
      event.preventDefault()
      ;(next as HTMLElement).focus()
    }
  }

  controller.add(registry.hold())
  controller.add(close)
  controller.listen('contextmenu', onContextMenu, { capture: true })
  controller.listen('pointerdown', onPointerDown, { capture: true })
  controller.listen('keydown', onKeyDown, { capture: true })
})
