/**
 * menu.ts — 右键菜单本体：按目标（会话行 / 工作区行 / 可编辑元素 / 选中文本 /
 * 链接 / 对话内容区）组装菜单项，处理键盘导航与外部点击关闭。
 *
 * 会话与工作区的官方操作全部转交官方组件（officialSelect）；插件只补充
 * 宿主能力（资源管理器、剪贴板、默认浏览器、刷新）。
 */
import type { ClientContext } from 'dsh-tauri/client'
import type {
  SessionsRuntimeLike,
  WorkspacesRuntimeLike,
} from './types'
import { compat } from 'dsh-tauri/client'
import {
  archiveSession,
  archiveUngroupedSessions,
  archiveWorkspaceSessions,
  deleteWorkspaceAction,
  forkSession,
  openExternalUrl,
  openInExplorer,
  renameSession,
} from './actions'
import { copyText, readClipboard } from './clipboard'
import {
  CONTEXT_MENU_EVENT,
  RIGHTCLICK_CLASSES as K,
  MENU_VIEWPORT_MARGIN,
} from './constants'
import { toast } from './dialog'
import { text } from './locale'
import { editableFrom, externalUrl, isWorkspaceAction, officialAction, resolveSession, rowFrom, selectedText, selectedUrl, ungroupedRowFrom, workspaceForSession, workspaceFrom } from './locate'
import { holdRegistryLease, registry } from './registry'

/** 官方工作区菜单项选择（工作区操作按钮无 hover 兜底）。 */
function officialWorkspaceSelect(row: Element, labels: RegExp[], failureMessage: string): void {
  const action = [...row.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(isWorkspaceAction)
  if (!action)
    throw new Error(text('officialWorkspaceActionUnavailable'))
  action.click()
  setTimeout(() => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node =>
      labels.some(label => label.test(node.textContent?.trim() || '')))
    if (!item) {
      toast(failureMessage)
      return
    }
    item.click()
  }, 0)
}

/**
 * 安装右键菜单。返回卸载函数（关闭菜单、移除监听、释放注册表租约）。
 * @param ctx - 客户端根上下文（须已注入 sessions/workspaces）。
 */
export function installContextMenu(ctx: ClientContext): () => void {
  const cx = compat(ctx)
  const sessions = cx.sessions as unknown as SessionsRuntimeLike
  const workspaces = cx.workspaces as unknown as WorkspacesRuntimeLike
  const extensionsRegistry = registry()
  const releaseLease = holdRegistryLease()

  let menu: HTMLElement | null = null
  const close = (): void => {
    menu?.remove()
    menu = null
  }

  const add = (root: HTMLElement, label: string, run: () => void | Promise<void>, shortcut = '', danger = false): void => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = danger ? `${K.item} ${K.itemDanger}` : K.item
    button.setAttribute('role', 'menuitem')
    button.tabIndex = -1
    const itemLabel = document.createElement('span')
    itemLabel.textContent = label
    button.appendChild(itemLabel)
    if (shortcut) {
      const hint = document.createElement('span')
      hint.className = K.shortcut
      hint.textContent = shortcut
      button.appendChild(hint)
    }
    button.onclick = async () => {
      close()
      try {
        await run()
      }
      catch (error) {
        toast(error instanceof Error ? error.message : String(error))
      }
    }
    root.appendChild(button)
  }
  const split = (root: HTMLElement): void => {
    if (!root.childElementCount || root.lastElementChild?.classList.contains(K.separator))
      return
    const node = document.createElement('div')
    node.className = K.separator
    node.setAttribute('role', 'separator')
    root.appendChild(node)
  }

  /** 替换可编辑元素中的当前选区（输入/文本域/可编辑区三态）。 */
  const replaceSelection = (editable: HTMLElement, value: string): void => {
    editable.focus()
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      const start = editable.selectionStart ?? editable.value.length
      const end = editable.selectionEnd ?? start
      editable.setRangeText(value, start, end, 'end')
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      return
    }
    const selection = globalThis.getSelection()
    if (!selection?.rangeCount || !editable.contains(selection.anchorNode))
      throw new Error(text('editPositionUnknown'))
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const textNode = document.createTextNode(value)
    range.insertNode(textNode)
    range.setStartAfter(textNode)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
  }

  /** 全选某个内容面（Range.selectNodeContents）。 */
  function selectSurface(surface: HTMLElement): void {
    if (!surface)
      return
    const selection = globalThis.getSelection()
    if (!selection)
      return
    const range = document.createRange()
    range.selectNodeContents(surface)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  /** 全选的可编辑目标。 */
  const selectAll = (editable: HTMLElement): void => {
    editable.focus()
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement)
      editable.select()
    else
      selectSurface(editable)
  }

  /** 全选的会话内容区（对话正文 / 设置弹窗 / hero 首屏）。 */
  const selectionSurface = (target: unknown): HTMLElement | null => {
    if (target instanceof Element) {
      const conversation = target.closest<HTMLElement>('[data-slot="conversation.session"]')
      if (conversation)
        return conversation
      const dialog = target.closest<HTMLElement>('[role="dialog"]')
      if (dialog)
        return dialog
      const hero = target.closest<HTMLElement>('[data-phase="hero"]')
      if (hero?.querySelector(':scope > [data-conversation-scroll]'))
        return hero
    }
    return null
  }

  /** 菜单定位：限制在视口内（最小边距 6px）。 */
  const position = (root: HTMLElement, event: MouseEvent): void => {
    const rect = root.getBoundingClientRect()
    root.style.left = `${Math.max(MENU_VIEWPORT_MARGIN, Math.min(event.clientX, innerWidth - rect.width - MENU_VIEWPORT_MARGIN))}px`
    root.style.top = `${Math.max(MENU_VIEWPORT_MARGIN, Math.min(event.clientY, innerHeight - rect.height - MENU_VIEWPORT_MARGIN))}px`
    root.style.visibility = 'visible'
    root.querySelector('button')?.focus()
  }

  const onContextMenu = (event: MouseEvent): void => {
    if (event.defaultPrevented)
      return
    const row = rowFrom(event.target)
    const ungroupedRow = !row ? ungroupedRowFrom(event.target) : null
    const domSessionWorkspace = row ? workspaceFrom(event.target, workspaces) : null
    const session = row ? resolveSession(sessions, row, domSessionWorkspace?.workspace ?? null) : null
    // The visible blank “New Session” is only a provisional composer target.
    if (session?.blank === true)
      return
    const resolvedWorkspace = domSessionWorkspace?.workspace || workspaceForSession(workspaces, session)
    const sessionWorkspace = resolvedWorkspace ? { workspace: resolvedWorkspace } : null
    const workspaceTarget = !row && !ungroupedRow ? workspaceFrom(event.target, workspaces) : null
    const editable = editableFrom(event.target)
    const selection = selectedText(editable).trim()
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
    const surface = selectionSurface(event.target)
    if (!row && !ungroupedRow && !workspaceTarget && !editable && !selection && !link && !surface)
      return
    event.preventDefault()
    event.stopPropagation()
    close()
    const root = document.createElement('div')
    root.className = K.menu
    root.setAttribute('role', 'menu')
    root.style.visibility = 'hidden'
    document.body.appendChild(root)
    menu = root

    const registeredExtensions = extensionsRegistry.list()
    globalThis.dispatchEvent(new CustomEvent(CONTEXT_MENU_EVENT, {
      detail: {
        row: row || ungroupedRow || workspaceTarget?.targetRow || null,
        action: row ? officialAction(row) : null,
        session,
        workspace: workspaceTarget?.workspace || null,
        target: event.target,
        x: event.clientX,
        y: event.clientY,
        extensions: registeredExtensions,
      },
    }))

    if (row) {
      add(root, text('renameSession'), () => renameSession(sessions, row, session))
      add(root, text('archiveSession'), () => archiveSession(workspaces, row, session))
      const cwd = session?.cwd || sessionWorkspace?.workspace.path
      if (cwd) {
        split(root)
        add(root, text('openInExplorer'), () => openInExplorer(cwd))
        add(root, text('copyWorkingDirectory'), () => copyText(cwd, 'copiedWorkingDirectory'))
      }
      if (session)
        add(root, text('copySessionId'), () => copyText(session.id, 'copiedSessionId'))

      split(root)
      add(root, text('forkSession'), () => forkSession(sessions, row, session))

      const extensions = session
        ? registeredExtensions.filter(entry => entry.visible?.({ session, row }) !== false)
        : []
      if (extensions.length) {
        split(root)
        for (const entry of extensions)
          add(root, entry.label || entry.id, () => entry.run({ session, row, sessions, workspaces, close }))
      }
      split(root)
      add(root, text('refresh'), () => globalThis.location.reload(), 'Ctrl+R')
    }
    else if (ungroupedRow) {
      add(root, text('archiveUngroupedSessions'), () => archiveUngroupedSessions(workspaces, sessions))
      split(root)
      add(root, text('refresh'), () => globalThis.location.reload(), 'Ctrl+R')
    }
    else if (workspaceTarget) {
      const workspace = workspaceTarget.workspace
      add(root, text('newSession'), () => workspaces.startSession(workspace.workspaceId))
      add(root, text('openInExplorer'), () => openInExplorer(workspace.path))
      split(root)
      add(root, text('renameWorkspace'), () => officialWorkspaceSelect(
        workspaceTarget.row,
        [/^重命名$/, /^rename$/i],
        text('officialWorkspaceRenameUnavailable'),
      ))
      add(root, text('copyWorkspacePath'), () => copyText(workspace.path, 'copiedWorkspacePath'))
      split(root)
      add(root, text('archiveWorkspaceSessions'), () => archiveWorkspaceSessions(workspaces, workspace))
      add(root, text('deleteWorkspace'), () => deleteWorkspaceAction(workspaces, workspace), '', true)

      split(root)
      add(root, text('refresh'), () => globalThis.location.reload(), 'Ctrl+R')
    }
    else if (editable) {
      add(root, text('undo'), () => {
        editable.focus()
        if (!document.execCommand('undo'))
          throw new Error(text('useUndoShortcut'))
      }, 'Ctrl+Z')
      add(root, text('redo'), () => {
        editable.focus()
        if (!document.execCommand('redo'))
          throw new Error(text('useRedoShortcut'))
      }, 'Ctrl+Y')
      split(root)
      add(root, text('cut'), async () => {
        if (selection)
          await copyText(selection, 'cutDone')
        replaceSelection(editable, '')
      }, 'Ctrl+X')
      add(root, text('copy'), () => copyText(selection, 'copied'), 'Ctrl+C')
      add(root, text('paste'), async () => replaceSelection(editable, await readClipboard()), 'Ctrl+V')
      split(root)
      add(root, text('selectAll'), () => selectAll(editable), 'Ctrl+A')
      split(root)
      add(root, text('refresh'), () => globalThis.location.reload(), 'Ctrl+R')
    }
    else {
      if (selection)
        add(root, text('copySelectedText'), () => copyText(selection, 'copied'), 'Ctrl+C')
      const url = externalUrl(link?.href || '') || selectedUrl(selection)
      if (url) {
        if (selection)
          split(root)
        add(root, text('openInDefaultBrowser'), () => openExternalUrl(url))
        add(root, text('copyLink'), () => copyText(url, 'linkCopied'))
      }
      if (surface) {
        if (selection || url)
          split(root)
        const surfaceNode = surface
        add(root, text('selectCurrentContent'), () => selectSurface(surfaceNode), 'Ctrl+A')
      }
      split(root)
      add(root, text('refresh'), () => globalThis.location.reload(), 'Ctrl+R')
    }
    position(root, event)
  }

  const outside = (event: PointerEvent): void => {
    if (menu && !menu.contains(event.target as Node))
      close()
  }
  const keyboard = (event: KeyboardEvent): void => {
    if (!menu)
      return
    if (event.key === 'Escape') {
      close()
      return
    }
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
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
  document.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', keyboard, true)

  let disposed = false
  return () => {
    if (disposed)
      return
    disposed = true
    close()
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', keyboard, true)
    releaseLease()
  }
}
