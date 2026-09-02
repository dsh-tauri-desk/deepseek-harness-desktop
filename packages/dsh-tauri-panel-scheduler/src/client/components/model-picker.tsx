import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'
import type { ModelOption } from '../types'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { SCHEDULER_CLASSES as K } from '../constants'

interface ModelPickerProps {
  value: string
  reasoningEffort: string
  models: readonly ModelOption[]
  followGlobalLabel: string
  modelLabel: string
  effortLabel: string
  defaultModelLabel: string
  providerDefaultLabel: string
  onSelection: (provider: string, model: string, reasoningEffort: string) => void
}

export function ModelPicker({
  value,
  reasoningEffort,
  models,
  followGlobalLabel,
  modelLabel,
  effortLabel,
  defaultModelLabel,
  providerDefaultLabel,
  onSelection,
}: ModelPickerProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const selected = models.find(item => `${item.provider}::${item.model}` === value)
  const reasoning = selected?.reasoning
  const effectiveEffort = reasoningEffort || reasoning?.defaultEffort || ''
  const effortName = reasoning?.efforts.find(item => item.id === effectiveEffort)?.name
  const trigger = selected?.label ?? defaultModelLabel

  const groups = Array.from(models.reduce((result, item) => {
    const group = result.get(item.provider) ?? { label: item.providerLabel, items: [] as ModelOption[] }
    group.items.push(item)
    result.set(item.provider, group)
    return result
  }, new Map<string, { label: string, items: ModelOption[] }>()))

  const selectModel = (item: ModelOption): void => {
    onSelection(item.provider, item.model, item.reasoning?.defaultEffort ?? '')
    setOpen(false)
  }

  const selectEffort = (id: string): void => {
    if (selected)
      onSelection(selected.provider, selected.model, id)
    setOpen(false)
  }

  let items: readonly MenuEntry[]
  if (pane === 'root') {
    items = [
      { id: '__model', label: `${modelLabel}: ${selected?.label ?? followGlobalLabel}` },
      ...(reasoning ? [{ id: '__effort', label: `${effortLabel}: ${effortName ?? providerDefaultLabel}` } satisfies MenuEntry] : []),
    ]
  }
  else if (pane === 'model') {
    items = [
      { id: '__follow-global', label: followGlobalLabel },
      ...groups.flatMap(([provider, group]) => [
        { type: 'label' as const, id: `label-${provider}`, text: group.label },
        ...group.items.map(item => ({ id: `${item.provider}::${item.model}`, label: item.description ? `${item.label} — ${item.description}` : item.label })),
      ]),
    ]
  }
  else {
    items = [
      ...(reasoning?.defaultEffort === undefined ? [{ id: '', label: providerDefaultLabel }] : []),
      ...(reasoning?.efforts ?? []).map(item => ({ id: item.id, label: item.description ? `${item.name} — ${item.description}` : item.name })),
    ]
  }

  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        if (pane === 'root') {
          setPane(id === '__model' ? 'model' : 'effort')
          return
        }
        if (pane === 'model') {
          if (id === '__follow-global') {
            onSelection('', '', '')
          }
          else {
            const item = models.find(model => `${model.provider}::${model.model}` === id)
            if (item)
              selectModel(item)
          }
        }
        else {
          selectEffort(id)
        }
      }}
      items={items}
      selectedId={pane === 'model' ? value || '__follow-global' : pane === 'effort' ? effectiveEffort : undefined}
      portal
      align="end"
      side="top"
      anchor={(
        <button
          type="button"
          className={K.selector}
          aria-label={modelLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setPane('root')
            setOpen(state => !state)
          }}
        >
          <span>{trigger}</span>
          {reasoning && <span className={K.selectorEffort}>{effortName ?? providerDefaultLabel}</span>}
          <IconChevronDownOutline14 className={K.selectorChevron} />
        </button>
      )}
    />
  )
}
