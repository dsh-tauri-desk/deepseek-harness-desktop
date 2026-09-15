import type { ClientContext } from 'dsh-tauri/client'
import { clockSvg, mountStyle } from 'dsh-tauri-ui/client'
import { compact, defineRegister, map } from 'dsh-tauri/client'
import { SESSION_ICON_ATTRIBUTE, SESSION_ICON_STYLE_ID, SIDEBAR_SELECTOR } from '../constants'
import { store } from '../store'
import sessionIconStyle from '../styles/index.cssr'

interface FiberLike {
  key?: unknown
  return?: FiberLike | null
}

// HARDCODE: DSH 0.1.1-rc.2 不暴露 per-row 槽位或 data id，只能读私有 React Fiber key。
function rowSessionId(element: Element): string | undefined {
  const fiberName = Object.keys(element).find(key => key.startsWith('__reactFiber$'))
  if (fiberName === undefined)
    return undefined
  let fiber = (element as Element & Record<string, FiberLike | undefined>)[fiberName]
  for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return ?? undefined) {
    if (typeof fiber.key === 'string')
      return fiber.key
  }
  return undefined
}

function sessionRows(): Map<string, Element> {
  const rows = new Map<string, Element>()
  for (const row of document.querySelectorAll<Element>('[role="treeitem"][aria-selected]')) {
    const id = rowSessionId(row)
    if (id)
      rows.set(id, row)
  }
  return rows
}

// HARDCODE: 锚定 rowActions 而非依赖文案的时间列；空行没有时间列，绝不回退插到标题之前。
function applyIcon(row: Element): void {
  if (row.querySelector(`[${SESSION_ICON_ATTRIBUTE}]`))
    return
  const actions = row.lastElementChild
  const time = actions?.previousElementSibling
  if (!actions?.querySelector('button') || !time || time.querySelector('button'))
    return

  const icon = document.createElement('span')
  icon.setAttribute(SESSION_ICON_ATTRIBUTE, '1')
  icon.innerHTML = clockSvg(12)
  row.insertBefore(icon, time)
}

function scan(): void {
  const scheduled = new Set(compact(map(store.scheduler.runs, 'sessionId')))
  for (const [sessionId, row] of sessionRows()) {
    const icon = row.querySelector<HTMLElement>(`[${SESSION_ICON_ATTRIBUTE}]`)
    if (scheduled.has(sessionId)) {
      if (!icon)
        applyIcon(row)
    }
    else {
      icon?.remove()
    }
  }
}

export const sessionIconsFeature = defineRegister<ClientContext>((controller) => {
  if (typeof document === 'undefined')
    return
  controller.add(mountStyle(sessionIconStyle, SESSION_ICON_STYLE_ID))
  controller.observe(document.body, scan)
  controller.add(store.scheduler.$subscribe(scan))

  const stopPolling = controller.interval(() => {
    if (document.querySelector(SIDEBAR_SELECTOR))
      stopPolling()
  }, 400)
})
