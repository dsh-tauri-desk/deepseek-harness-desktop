import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { SCHEDULER_CLASSES as K } from '../constants'

/**
 * components/menu-select.tsx — 官方风格的「下拉选择」：primitives `Menu`
 * 锚定在 pill 触发按钮（LanguageRow selector 样式）上。
 *
 * 官方 UI 没有独立 Select 组件；标准做法是「触发按钮 + Menu」（参见官方
 * LanguageRow 与 dsh-tauri-session 的 menu-select.tsx）。本组件封装该模式：
 * 触发按钮显示当前选项与下箭头，Menu 以 portal 方式打开（align=end，
 * 避免被祖先裁剪）。
 */

export interface MenuSelectOption {
  id: string
  label: string
}

export interface MenuSelectProps {
  /** 当前选中项 id。 */
  value: string
  /** 有序选项列表。 */
  options: MenuSelectOption[]
  /** 选中回调（携带选项 id）。 */
  onSelect: (id: string) => void
  /** 触发按钮的无障碍名称（aria-label）。 */
  label: string
}

/** 官方风格下拉选择器。 */
export function MenuSelect({ value, options, onSelect, label }: MenuSelectProps): ReactElement {
  const [open, setOpen] = useState(false)

  const current = options.find(option => option.id === value)
  const items: MenuEntry[] = options.map(option => ({ id: option.id, label: option.label }))

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
      closeOnPointerLeave
      align="end"
      anchor={(
        <button
          type="button"
          className={K.selector}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(openState => !openState)}
        >
          <span>{current?.label ?? value}</span>
          <IconChevronDownOutline14 className={K.selectorChevron} />
        </button>
      )}
    />
  )
}
