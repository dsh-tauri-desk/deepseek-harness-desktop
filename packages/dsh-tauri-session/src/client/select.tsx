import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
/**
 * menu-select.tsx — 官方风格的「下拉选择」：primitives `Menu` 锚定在触发按钮上。
 *
 * 官方 UI 没有独立 `Select` 组件；设置页/选择器的标准做法是「触发按钮 + Menu」
 * （参见官方 ModelSelect）。本组件封装该模式：触发按钮显示当前选项与旋转箭头，
 * Menu 以 portal 形式打开（align=end，避免被祖先裁剪）。
 */
import type { ReactElement } from 'react'
import type { MenuSelectProps } from './types'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { SESSION_CLASSES as K } from './constants'
import { IconChevronDown } from './icons'
import { useLocale } from './locale'

/**
 * 官方风格下拉选择器。
 * @param props - 下拉选择器 props。
 * @param props.value - 当前选中项 id。
 * @param props.options - 有序选项列表。
 * @param props.onSelect - 选中回调（携带选项 id）。
 * @param props.label - 触发按钮的无障碍名称（aria-label）。
 */
export function MenuSelect({ value, options, onSelect, label }: MenuSelectProps): ReactElement {
  const [open, setOpen] = useState(false)
  useLocale()

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
          className={K.menuSelect}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(openState => !openState)}
        >
          <span className={K.menuSelectLabel}>{current?.label ?? value}</span>
          <IconChevronDown size={14} className={K.menuSelectChevron} />
        </button>
      )}
    />
  )
}
