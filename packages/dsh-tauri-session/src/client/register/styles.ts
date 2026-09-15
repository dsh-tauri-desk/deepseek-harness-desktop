import { mountStyle } from 'dsh-tauri-ui/client'
import { defineRegister } from 'dsh-tauri/client'
import { SESSION_MENU_STYLE_ID } from '../constants'
import workspaceMenuStyle from '../styles/workspace-menu.cssr'

export const stylesFeature = defineRegister((controller) => {
  controller.add(mountStyle(workspaceMenuStyle, SESSION_MENU_STYLE_ID))
})
