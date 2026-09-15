import type { ExtensionRouteDeps } from '../../index.types'
import { defineEventHandler, dshRouteDepsOf } from 'dsh-tauri'
import { skillCatalog } from '../../../service/skill-catalog'

export default defineEventHandler(async (event) => {
  try {
    await dshRouteDepsOf<ExtensionRouteDeps>(event)!.remountProvider()
    return { skills: await skillCatalog.resolve() }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
