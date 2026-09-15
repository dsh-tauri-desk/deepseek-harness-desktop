import { mountStyle } from 'dsh-tauri-ui/client'
import { defineRegister } from 'dsh-tauri/client'
import { STYLE_ID } from '../constants'
import extensionIndexStyle from '../styles/index.cssr'

export const stylesFeature = defineRegister((controller) => {
  controller.add(mountStyle(extensionIndexStyle, STYLE_ID))
})
