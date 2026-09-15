export interface MenuSelectOption {
  id: string
  label: string
}

export interface MenuSelectProps {
  value: string
  options: readonly MenuSelectOption[]
  onSelect: (id: string) => void
  label: string
  variant?: 'pill' | 'default'
  triggerClassName?: string
  labelClassName?: string
  chevronClassName?: string
}
