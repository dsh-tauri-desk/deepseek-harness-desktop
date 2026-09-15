import { defineEventHandler } from 'dsh-tauri'
import { skillCatalog } from '../../service/skill-catalog'

export default defineEventHandler(async (event) => {
  try {
    return { skills: await skillCatalog.resolve() }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
