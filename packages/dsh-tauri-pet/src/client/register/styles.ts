import { mountStyle } from 'dsh-tauri-ui/client'
import { defineRegister } from 'dsh-tauri/client'
import { PET_STYLES_ID } from '../constants'
import petEntryStyle from '../styles/index.cssr'

/** 侧栏入口与设置行布局的公共样式（无组件面）。 */
export const stylesFeature = defineRegister((controller) => {
  controller.add(mountStyle(petEntryStyle, PET_STYLES_ID))
})
