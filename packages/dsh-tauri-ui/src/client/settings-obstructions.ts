import {
  SETTINGS_EXTERNAL_OVERLAY_SELECTORS,
  SETTINGS_UNDERLAY_SLOT_KEYS,
} from './constants'

interface SettingsObstructionState {
  displayPriority: string
  displayValue: string
  element: HTMLElement
  widthPriority: string
  widthValue: string
}

interface SidebarWidthState {
  hadInlineValue: boolean
  priority: string
  value: string
}

const SIDEBAR_WIDTH_PROPERTY = '--dsh-sidebar-width'

/**
 * Finds host surfaces that could remain above or show through the settings overlay.
 * A set is required because an independently mounted overlay may also own a slot anchor.
 */
export function getSettingsObstructionTargets(root: ParentNode): HTMLElement[] {
  const targets = new Set<HTMLElement>()

  for (const slotKey of SETTINGS_UNDERLAY_SLOT_KEYS) {
    const anchor = root.querySelector<HTMLElement>(`[data-slot="${slotKey}"]`)
    if (anchor)
      targets.add(anchor.parentElement ?? anchor)
  }

  for (const selector of SETTINGS_EXTERNAL_OVERLAY_SELECTORS) {
    for (const element of root.querySelectorAll<HTMLElement>(selector))
      targets.add(element)
  }

  return [...targets]
}

/**
 * Hides the underlying layout while the docked settings page is open.
 * better-sidebar reserves space through --dsh-sidebar-width, so both the
 * panel and that layout push must be removed for settings to use the full width.
 */
export function concealSettingsObstructions(root: ParentNode = document): () => void {
  const documentRoot = document.documentElement
  const sidebarWidth = documentRoot.style.getPropertyValue(SIDEBAR_WIDTH_PROPERTY)
  const previousSidebarWidth: SidebarWidthState = {
    hadInlineValue: sidebarWidth !== '',
    priority: documentRoot.style.getPropertyPriority(SIDEBAR_WIDTH_PROPERTY),
    value: sidebarWidth,
  }
  const previous = new Map<HTMLElement, SettingsObstructionState>()
  let restored = false

  documentRoot.style.setProperty(SIDEBAR_WIDTH_PROPERTY, '0', 'important')

  const reconcile = (): void => {
    if (restored)
      return

    // Reapply this because better-sidebar may update its layout variable while
    // the settings page remains open.
    documentRoot.style.setProperty(SIDEBAR_WIDTH_PROPERTY, '0', 'important')

    for (const element of getSettingsObstructionTargets(root)) {
      if (!previous.has(element)) {
        previous.set(element, {
          displayPriority: element.style.getPropertyPriority('display'),
          displayValue: element.style.getPropertyValue('display'),
          element,
          widthPriority: element.style.getPropertyPriority('width'),
          widthValue: element.style.getPropertyValue('width'),
        })
      }
      element.style.setProperty('display', 'none', 'important')
      element.style.setProperty('width', '0', 'important')
    }
  }

  const ownerDocument = root instanceof Document
    ? root
    : (root as Node).ownerDocument
  const observerRoot = root instanceof Document
    ? root.documentElement
    : (root as Node)
  const Observer = ownerDocument?.defaultView?.MutationObserver ?? MutationObserver
  const observer = new Observer(reconcile)

  observer.observe(observerRoot, {
    attributeFilter: ['data-dsh-better-sidebar', 'data-slot'],
    attributes: true,
    childList: true,
    subtree: true,
  })
  reconcile()

  return () => {
    if (restored)
      return

    restored = true
    observer.disconnect()

    for (const {
      displayPriority,
      displayValue,
      element,
      widthPriority,
      widthValue,
    } of previous.values()) {
      if (displayValue !== '')
        element.style.setProperty('display', displayValue, displayPriority)
      else
        element.style.removeProperty('display')
      if (widthValue !== '')
        element.style.setProperty('width', widthValue, widthPriority)
      else
        element.style.removeProperty('width')
    }

    if (previousSidebarWidth.hadInlineValue) {
      documentRoot.style.setProperty(
        SIDEBAR_WIDTH_PROPERTY,
        previousSidebarWidth.value,
        previousSidebarWidth.priority,
      )
    }
    else {
      documentRoot.style.removeProperty(SIDEBAR_WIDTH_PROPERTY)
    }

    previous.clear()
  }
}
