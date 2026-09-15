import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'
import type { MenuSelectProps } from './menu-select.types'
import { IconChevronDownOutline14 as ChevronDown, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { compact } from 'dsh-tauri/client'
import { useState } from 'react'
import { MENU_SELECT_STYLE_ID } from '../constants'
import { useMountStyle } from '../hooks/use-mount-style'
import { Icon } from './icon'
import menuSelectStyle from './menu-select.cssr'

export function MenuSelect({
  value,
  options,
  onSelect,
  label,
  variant = 'default',
  triggerClassName,
  labelClassName,
  chevronClassName,
}: MenuSelectProps): ReactElement {
  const [open, setOpen] = useState(false)
  useMountStyle(menuSelectStyle, MENU_SELECT_STYLE_ID)
  const current = options.find(option => option.id === value)
  const items: MenuEntry[] = options.map(option => ({ id: option.id, label: option.label }))
  const triggerClass = compact([
    'dshp-menu-select',
    variant === 'pill' && 'dshp-menu-select--pill',
    triggerClassName,
  ]).join(' ')

  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        setOpen(false)
        onSelect(id)
      }}
      items={items}
      selectedId={value}
      portal
      align="end"
      anchor={(
        <button
          type="button"
          className={triggerClass}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(openState => !openState)}
        >
          <span className={labelClassName}>{current?.label ?? value}</span>
          <Icon as={ChevronDown} className={chevronClassName} />
        </button>
      )}
    />
  )
}
