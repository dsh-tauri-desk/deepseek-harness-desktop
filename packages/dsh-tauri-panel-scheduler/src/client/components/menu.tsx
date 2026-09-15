import type { CSSProperties, ReactNode, RefObject } from 'react'
import { useMountStyle } from 'dsh-tauri-ui/client'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MENU_STYLE_ID } from '../constants'
import menuStyle from './menu.cssr'

const MenuHostContext = createContext<HTMLElement | null>(null)

function useMenuOpen(): {
  readonly open: boolean
  readonly setOpen: (value: boolean | ((current: boolean) => boolean)) => void
  readonly root: React.RefObject<HTMLDivElement | null>
  readonly menu: React.RefObject<HTMLDivElement | null>
} {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open)
      return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (root.current !== null && root.current.contains(target))
        return
      if (menu.current !== null && menu.current.contains(target))
        return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => {
      document.removeEventListener('mousedown', close)
    }
  }, [open])

  return { open, setOpen, root, menu }
}

function flyoutStyle(anchor: HTMLElement, host: HTMLElement, up?: boolean, end?: boolean): CSSProperties {
  const box = anchor.getBoundingClientRect()
  const frame = host.getBoundingClientRect()
  const gap = 6
  return {
    position: 'absolute',
    zIndex: 1200,
    top: up === true ? 'auto' : `${box.bottom - frame.top + gap}px`,
    bottom: up === true ? `${frame.bottom - box.top + gap}px` : 'auto',
    left: end === true ? 'auto' : `${box.left - frame.left}px`,
    right: end === true ? `${frame.right - box.right}px` : 'auto',
  }
}

export function MenuPopup({
  open,
  anchor,
  menuRef,
  up,
  end,
  className,
  ariaLabel,
  children,
  onClick,
}: {
  readonly open: boolean
  readonly anchor: RefObject<HTMLElement | null>
  readonly menuRef: RefObject<HTMLDivElement | null>
  readonly up?: boolean | undefined
  readonly end?: boolean | undefined
  readonly className: string
  readonly ariaLabel?: string
  readonly children: ReactNode
  readonly onClick?: () => void
}) {
  const host = useContext(MenuHostContext)
  const [style, setStyle] = useState<CSSProperties>({})

  useLayoutEffect(() => {
    if (!open || anchor.current === null || host === null)
      return
    const update = (): void => {
      if (anchor.current !== null)
        setStyle(flyoutStyle(anchor.current, host, up, end))
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [open, anchor, host, up, end])

  if (!open)
    return null

  const node = (
    <div
      ref={menuRef}
      className={`${className}${host !== null ? ` ${'dshp-scheduler__menu-float'}` : ''}`}
      role="menu"
      aria-label={ariaLabel}
      style={host !== null ? style : undefined}
      onMouseDown={event => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.()
      }}
    >
      {children}
    </div>
  )

  if (host !== null)
    return createPortal(node, host)
  return node
}

export function MenuHostProvider({
  host,
  children,
}: {
  readonly host: HTMLElement | null
  readonly children: ReactNode
}) {
  useMountStyle(menuStyle, MENU_STYLE_ID)
  return <MenuHostContext.Provider value={host}>{children}</MenuHostContext.Provider>
}

export function MenuRow({
  icon,
  label,
  hint,
  active,
  chevron,
  kv,
  onClick,
}: {
  readonly icon?: ReactNode
  readonly label: ReactNode
  readonly hint?: ReactNode
  readonly active?: boolean
  readonly chevron?: boolean
  readonly kv?: boolean
  readonly onClick: () => void
}) {
  return (
    <button type="button" className={`${'dshp-scheduler__menu-row'}${active === true ? ' is-on' : ''}${kv === true ? ' is-kv' : ''}`} onClick={onClick}>
      <span className="dshp-scheduler__menu-row-main">
        {icon}
        <span>{label}</span>
      </span>
      <span className="dshp-scheduler__menu-row-side">
        {hint}
        {active === true && chevron !== true && <i className="dshp-scheduler__menu-tick" />}
        {chevron === true && <i className="dshp-scheduler__menu-next" />}
      </span>
    </button>
  )
}

export function useMenuState(): ReturnType<typeof useMenuOpen> {
  return useMenuOpen()
}
