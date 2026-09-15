import type { ReactElement } from 'react'
import type { SettingsTriggerProps } from './trigger.types'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
import { uniq, useStore } from 'dsh-tauri/client'
import { useCallback, useEffect, useState } from 'react'
import {
  SETTINGS_ONBOARDING_SLOT,
  SETTINGS_TRIGGER_SLOT,
  SETTINGS_TRIGGER_STYLE_ID,
} from '../constants'
import { useMountStyle } from '../hooks/use-mount-style'
import { store } from '../store'
import settingsTriggerStyle from './trigger.cssr'

export function SettingsTrigger({ wide, useSessions }: SettingsTriggerProps): ReactElement {
  const { open } = useStore(store.settings)
  const { onboarding } = useStore(store.sections)
  useMountStyle(settingsTriggerStyle, SETTINGS_TRIGGER_STYLE_ID)
  const [completed, setCompleted] = useState<string[]>([])

  const onboardingActive = useSessions(
    state =>
      state.phase === 'ready'
      && (state.current === undefined || state.byId[state.current]?.blank === true),
  )

  useEffect(() => {
    if (!onboardingActive)
      setCompleted([])
  }, [onboardingActive])

  const step = onboardingActive ? onboarding.find(s => !completed.includes(s.id)) : undefined

  const completeStep = useCallback((id: string) => {
    setCompleted(previous => uniq([...previous, id]))
  }, [])

  const openSection = useCallback((id: string) => {
    store.settings.openAt(id)
  }, [])

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => store.settings.openAt()}
        className={`dshp-settings-trigger${wide ? '' : ' dshp-settings-trigger--rail'}`}
      >
        <SlotOutlet slotKey={SETTINGS_TRIGGER_SLOT} ownerProps={{ wide }} />
      </button>
      {step !== undefined && (
        <SlotOutlet
          slotKey={SETTINGS_ONBOARDING_SLOT}
          ownerProps={{
            stepId: step.id,
            complete: () => completeStep(step.id),
            openSection,
          }}
          opts={{ only: step.id }}
        />
      )}
    </>
  )
}
