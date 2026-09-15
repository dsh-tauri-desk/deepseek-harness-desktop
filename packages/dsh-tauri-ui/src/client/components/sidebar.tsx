import type { CSSProperties, ReactElement, PointerEvent as ReactPointerEvent } from 'react'
import type { SettingsSidebarProps } from './sidebar.types'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
import { clamp, isEmpty, useEventListener, useStore } from 'dsh-tauri/client'
import { useEffect, useRef, useState } from 'react'
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  SETTINGS_SECTION_SLOT,
  SETTINGS_SIDEBAR_CLASS,
  SETTINGS_STYLE_ID,
} from '../constants'
import { useMountStyle } from '../hooks/use-mount-style'
import { locale } from '../locales'
import { store } from '../store'
import { Icon } from './icon'
import { ArrowLeft } from './icons'
import { SettingsNavIcon } from './nav-icon'
import settingsSidebarStyle from './sidebar.cssr'

export function SettingsSidebar(_props: SettingsSidebarProps): ReactElement | null {
  const ui = useStore(store.settings, { sync: true })
  const { rows } = useStore(store.sections)
  locale.useLocale()
  useMountStyle(settingsSidebarStyle, SETTINGS_STYLE_ID)
  const searchRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  const originRef = useRef({ width: RAIL_WIDTH_DEFAULT, x: 0 })
  const documentRef = useRef<Document | null | undefined>(
    typeof document === 'undefined' ? undefined : document,
  )

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    originRef.current = {
      width: store.settings.railWidth ?? RAIL_WIDTH_DEFAULT,
      x: event.clientX,
    }
    draggingRef.current = true
    setDragging(true)
  }

  useEventListener('pointermove', (event) => {
    if (!draggingRef.current)
      return
    store.settings.setRailWidth(
      clamp(originRef.current.width + event.clientX - originRef.current.x, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX),
    )
  })

  useEventListener('pointerup', () => {
    if (!draggingRef.current)
      return
    draggingRef.current = false
    setDragging(false)
  })

  useEventListener(documentRef, 'keydown', (event: KeyboardEvent) => {
    if (ui.open && event.key === 'Escape')
      store.settings.close()
  })

  useEffect(() => {
    if (!ui.open)
      return
    const el = document.querySelector('[data-slot="sidebar"]')
    const width = el?.getBoundingClientRect().width
    if (typeof width === 'number' && width >= RAIL_WIDTH_MIN)
      store.settings.setRailWidth(clamp(width, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX))
    searchRef.current?.focus()
  }, [ui.open])

  if (!ui.open)
    return null

  const railWidth = ui.railWidth ?? RAIL_WIDTH_DEFAULT
  const query = ui.query.trim().toLowerCase()
  const visible = query
    ? rows.filter(
        row =>
          row.label.toLowerCase().includes(query) || row.id.toLowerCase().includes(query),
      )
    : rows
  const activeId = visible.some(row => row.id === ui.activeId)
    ? ui.activeId
    : visible[0]?.id

  return (
    <div className={SETTINGS_SIDEBAR_CLASS} data-slot-sidebar="dsh-tauri-ui">
      <div
        className={`${SETTINGS_SIDEBAR_CLASS}__rail`}
        style={{ '--dsh-settings-rail-width': `${railWidth}px` } as CSSProperties}
      >
        <button
          type="button"
          className={`${SETTINGS_SIDEBAR_CLASS}__back`}
          onClick={() => store.settings.close()}
        >
          <Icon as={ArrowLeft} />
          {locale.text('back')}
        </button>
        <input
          ref={searchRef}
          className={`${SETTINGS_SIDEBAR_CLASS}__search`}
          value={ui.query}
          placeholder={locale.text('search')}
          aria-label={locale.text('search')}
          onChange={event => store.settings.setQuery(event.target.value)}
        />
        <nav className={`${SETTINGS_SIDEBAR_CLASS}__nav`} aria-label={locale.text('settings')}>
          {visible.map(row => (
            <button
              key={row.id}
              type="button"
              className={`${SETTINGS_SIDEBAR_CLASS}__nav-item${row.id === activeId ? ` ${SETTINGS_SIDEBAR_CLASS}__nav-item--active` : ''}`}
              aria-current={row.id === activeId ? 'true' : undefined}
              onClick={() => store.settings.select(row.id)}
            >
              <SettingsNavIcon id={row.id} />
              <span className={`${SETTINGS_SIDEBAR_CLASS}__nav-label`}>{row.label}</span>
            </button>
          ))}
          {isEmpty(visible) && <div className={`${SETTINGS_SIDEBAR_CLASS}__empty`}>{locale.text('noResults')}</div>}
        </nav>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={locale.text('settings')}
        className={`${SETTINGS_SIDEBAR_CLASS}__handle${dragging ? ` ${SETTINGS_SIDEBAR_CLASS}__handle--dragging` : ''}`}
        onPointerDown={onHandlePointerDown}
      />
      <div className={`${SETTINGS_SIDEBAR_CLASS}__content-outer`}>
        <div className={`${SETTINGS_SIDEBAR_CLASS}__content-inner`}>
          {activeId !== undefined && (
            <SlotOutlet
              slotKey={SETTINGS_SECTION_SLOT}
              ownerProps={{ close: () => store.settings.close() }}
              opts={{ only: activeId }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
