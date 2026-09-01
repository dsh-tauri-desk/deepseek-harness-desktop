/**
 * menu.ts — 右键菜单控制器：按目标（会话行 / 工作区行 / 可编辑元素 / 选中文本 /
 * 链接 / 对话内容区）解析并组装菜单，处理键盘导航与外部点击关闭。
 *
 * 职责边界：
 *   - DOM 构建（菜单项/分隔线/定位）→ ../dom/menu-item.ts；
 *   - 选区操作（替换/全选）→ ../utils/editable.ts；
 *   - 业务动作（RPC/剪贴板/官方菜单转交）→ ./actions.ts；
 * 本文件只保留「目标解析 + 菜单组装 + 生命周期」，不再混入 DOM 细节。
 *
 * 会话与工作区的官方操作全部转交官方组件（officialSelect）；插件只补充
 * 宿主能力（资源管理器、剪贴板、默认浏览器、刷新）。
 */
import type { ClientContext } from 'dsh-tauri/client'
import type {
  SessionsRuntimeLike,
  WorkspacesRuntimeLike,
} from '../types'
import { compat, createLifecycleController } from 'dsh-tauri/client'
import {
  CONTEXT_MENU_EVENT,
  RIGHTCLICK_CLASSES as K,
} from '../constants'
import { editableFrom, externalUrl, officialAction, resolveSession, rowFrom, selectedText, selectedUrl, ungroupedRowFrom, workspaceForSession, workspaceFrom } from '../dom/locate'
import { createMenuItem, createMenuRoot, createSeparator, positionMenu } from '../dom/menu-item'
import { text } from '../locales'
import { copyText, readClipboard } from '../utils/clipboard'
import { toast } from '../utils/dialog'
import { replaceSelection, selectAll, selectionSurface, selectSurface } from '../utils/editable'
import {
  archiveSession,
  archiveUngroupedSessions,
  archiveWorkspaceSessions,
  deleteWorkspaceAction,
  forkSession,
  officialSelect,
  openExternalUrl,
  openInExplorer,
  renameSession,
} from './actions'
import { holdRegistryLease, registry } from './registry'

/**
 * 安装右键菜单。返回卸载函数（关闭菜单并 dispose 生命周期控制器）。
 * @param ctx - 客户端根上下文（须已注入 sessions/workspaces）。
 */
export function installContextMenu(ctx: ClientContext): () => void {
  const cx = compat(ctx)
  const sessions = cx.sessions as unknown as SessionsRuntimeLike
  const workspaces = cx.workspaces as unknown as WorkspacesRuntimeLike
  const extensionsRegistry = registry()
  const controller = createLifecycleController()
  // 注册表租约：apply 时持有、dispose 时释放（哪怕 listeners 先失效）。
  controller.add(holdRegistryLease())

  let menu: HTMLElement | null = null
  const close = (): void => {
    menu?.remove()
    menu = null
  }
  controller.add(close)

  /** 追加菜单项（含 close + 错误 toast 包装；run 可为异步）。 */
  const add = (root: HTMLElement, label: string, run: () => void | Promise<void>, shortcut = '', danger = false): void => {
    root.appendChild(createMenuItem({
      label,
      shortcut,
      danger,
      onClick: async () => {
        close()
        try {
          await run()
        }
        catch (error) {
          toast(error instanceof Error ? error.message : String(error))
        }
      },
    }))
  }
  /** 追加分隔线（已有条目且末项不是分隔线时才加）。 */
  const split = (root: HTMLElement): void => {
    if (!root.childElementCount || root.lastElementChild?.classList.contains(K.separator))
      return
    root.appendChild(createSeparator())
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
    const root = createMenuRoot()
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
      add(root, text('renameWorkspace'), () => officialSelect(
        workspaceTarget.row,
        [/^重命名$/, /^rename$/i],
        text('officialWorkspaceRenameUnavailable'),
        { workspace: true, schedule: (fn, ms) => controller.timeout(fn, ms) },
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
    positionMenu(root, event.clientX, event.clientY)
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
  controller.listen('contextmenu', onContextMenu, { capture: true })
  controller.listen('pointerdown', outside, { capture: true })
  controller.listen('keydown', keyboard, { capture: true })

  return () => controller.dispose()
}
