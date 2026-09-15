import { defineEventHandler, readBody } from 'dsh-tauri'
import { skills } from '../../../service/skills'

interface SkillDeleteBody { name?: unknown }

export default defineEventHandler(async (event) => {
  const body = await readBody<SkillDeleteBody>(event, { type: 'json' })
  const name = typeof body?.name === 'string' ? body.name : ''
  try {
    if (!skills.remove(name)) {
      event.res.status = 404
      return { error: 'skill not found' }
    }
    return { ok: true, name }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
