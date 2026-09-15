import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { GLOBAL_STYLE_ID, TURN_NAVIGATION_STYLE_ID } from '../constants'
import globalStyle from '../styles/global.cssr'
import turnNavigationStyle from '../styles/index.cssr'
import { mountStyle } from '../utils/style'

export const registerStyles = defineRegister<ClientContext>((controller) => {
  controller.add(mountStyle(globalStyle, GLOBAL_STYLE_ID))
  controller.add(mountStyle(turnNavigationStyle, TURN_NAVIGATION_STYLE_ID))
})
