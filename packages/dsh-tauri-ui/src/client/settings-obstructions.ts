import {
  SETTINGS_EXTERNAL_OVERLAY_SELECTORS,
  SETTINGS_UNDERLAY_SLOT_KEYS,
} from './constants'

interface SettingsObstructionState {
  element: HTMLElement
  inert: boolean
  hadInlineOpacity: boolean
  opacityPriority: string
  opacityValue: string
}

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
 * Temporarily conceals and disables every surface below the docked settings page.
 * Newly mounted plugin surfaces are reconciled while settings remains open. The
 * disposer stops observation and restores every surface's exact inline state.
 */
export function concealSettingsObstructions(root: ParentNode = document): () => void {
  const previous = new Map<HTMLElement, SettingsObstructionState>()
  let restored = false

  const reconcile = (): void => {
    if (restored)
      return

    for (const element of getSettingsObstructionTargets(root)) {
      if (!previous.has(element)) {
        const opacityValue = element.style.getPropertyValue('opacity')
        previous.set(element, {
          element,
          inert: element.inert,
          hadInlineOpacity: opacityValue !== '',
          opacityPriority: element.style.getPropertyPriority('opacity'),
          opacityValue,
        })
      }

      // Inline !important keeps independently mounted overlays concealed even
      // when they supplied their own important opacity declaration.
      element.style.setProperty('opacity', '0', 'important')
      element.inert = true
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
      element,
      hadInlineOpacity,
      inert,
      opacityPriority,
      opacityValue,
    } of previous.values()) {
      if (hadInlineOpacity)
        element.style.setProperty('opacity', opacityValue, opacityPriority)
      else
        element.style.removeProperty('opacity')
      element.inert = inert
    }

    previous.clear()
  }
}
