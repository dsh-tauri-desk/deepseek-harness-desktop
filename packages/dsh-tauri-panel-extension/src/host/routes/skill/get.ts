import { defineEventHandler, getQuery } from 'dsh-tauri'
import { skillCatalog } from '../../service/skill-catalog'

export default defineEventHandler(async (event) => {
  const query = getQuery(event) as { name?: unknown }
  const name = typeof query.name === 'string' ? query.name : ''
  try {
    const definition = await skillCatalog.peek(name)
    if (definition === null) {
      event.res.status = 404
      return { error: 'skill not found' }
    }
    return { name: definition.name, content: definition.content }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
