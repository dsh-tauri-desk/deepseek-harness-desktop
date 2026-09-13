import { cssr } from 'dsh-tauri-ui/client'

const { c } = cssr

export default c([
  c('[class$="userStack"]', {
    width: '100%',
  }),
])
