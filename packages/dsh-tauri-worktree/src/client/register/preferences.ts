import { defineRegister } from 'dsh-tauri/client'
import { loadPreferredMode } from '../service/preferences'

export const preferencesFeature = defineRegister(() => {
  void loadPreferredMode()
})
