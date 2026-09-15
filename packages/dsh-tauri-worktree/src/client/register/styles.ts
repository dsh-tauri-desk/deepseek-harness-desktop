import { mountStyle } from 'dsh-tauri-ui/client'
import { defineRegister } from 'dsh-tauri/client'
import modeSelectStyle from '../components/mode-select.cssr'
import { MODE_SELECT_STYLE_ID, WORKTREE_STYLE_ID } from '../constants'
import worktreeIndexStyle from '../styles/index.cssr'

export const stylesFeature = defineRegister((controller) => {
  controller.add(mountStyle(modeSelectStyle, MODE_SELECT_STYLE_ID))
  controller.add(mountStyle(worktreeIndexStyle, WORKTREE_STYLE_ID))
})
