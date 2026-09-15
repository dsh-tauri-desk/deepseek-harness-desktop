import { defineEventHandler } from 'dsh-tauri'
import { rootView } from '../../service/skill-catalog.utils'
import { skillRoot } from '../../service/skill-root'

export default defineEventHandler(async () => {
  return { roots: (await skillRoot.list()).map(rootView) }
})
