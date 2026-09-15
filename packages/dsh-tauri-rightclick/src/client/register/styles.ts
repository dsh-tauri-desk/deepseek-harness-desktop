import { mountStyle } from 'dsh-tauri-ui/client'
import { defineRegister } from 'dsh-tauri/client'
import { MENU_STYLE_ID } from '../constants'
import menuStyle from '../styles/index.cssr'

export const stylesFeature = defineRegister((controller) => {
  controller.add(mountStyle(menuStyle, MENU_STYLE_ID))
})
