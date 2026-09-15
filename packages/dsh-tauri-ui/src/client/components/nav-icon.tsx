import type { ReactElement } from 'react'
import {
  IconAgentPresetOutline16,
  IconDataOutline16,
  IconPersonalizationOutline16,
  IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { get } from 'dsh-tauri/client'
import { SETTINGS_NAV_ICON_STYLE_ID } from '../constants'
import { useMountStyle } from '../hooks/use-mount-style'
import { Icon } from './icon'
import settingsNavIconStyle from './nav-icon.cssr'

const NAV_ICONS: Record<string, typeof IconSettingsOutline16> = {
  'models': IconDataOutline16,
  'agent-presets': IconAgentPresetOutline16,
  'plugins': IconPersonalizationOutline16,
}

export function SettingsNavIcon({ id }: { id: string }): ReactElement {
  useMountStyle(settingsNavIconStyle, SETTINGS_NAV_ICON_STYLE_ID)
  const NavIcon = get(NAV_ICONS, id, IconSettingsOutline16)
  return <Icon as={NavIcon} size={16} className="dshp-settings-nav-icon" />
}
