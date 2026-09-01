/** types/ui.ts — 通用 UI 组件类型（图标 / 下拉选择器）。 */

/** Shared props for the local gravity-ui icon components. */
export interface IconProps {
  size?: number
  className?: string
}

/** One option of the official-style dropdown (primitives Menu select). */
export interface MenuSelectOption {
  id: string
  label: string
}

/** Props for the official-style `Menu`-based select trigger. */
export interface MenuSelectProps {
  /** Selected option id. */
  value: string
  /** Ordered options. */
  options: MenuSelectOption[]
  /** Called with the picked option id. */
  onSelect: (id: string) => void
  /** Accessible trigger name (aria-label). */
  label: string
}
