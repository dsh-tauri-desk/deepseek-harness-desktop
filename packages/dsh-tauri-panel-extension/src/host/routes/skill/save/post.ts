import type { SkillInput } from '../../../service/skills.types'
import { defineEventHandler, readBody } from 'dsh-tauri'
import { join } from 'pathe'
import { SKILL_FILE_NAME } from '../../../config/constants'
import { skillCatalog } from '../../../service/skill-catalog'
import { skills } from '../../../service/skills'
import { validateSkillInput } from '../../../service/skills.utils'

export default defineEventHandler(async (event) => {
  const body = await readBody<Partial<SkillInput>>(event, { type: 'json' })
  const input: SkillInput = {
    name: typeof body?.name === 'string' ? body.name : '',
    description: typeof body?.description === 'string' ? body.description : '',
    whenToUse: typeof body?.whenToUse === 'string' ? body.whenToUse : undefined,
    modelInvocable: body?.modelInvocable !== false,
    userInvocable: body?.userInvocable !== false,
    content: typeof body?.content === 'string' ? body.content : '',
  }
  try {
    const invalid = validateSkillInput(input)
    if (invalid !== null) {
      event.res.status = 400
      return { error: invalid }
    }
    const existing = (await skillCatalog.resolve()).find(skill => skill.name === input.name)
    if (existing !== undefined) {
      if (existing.dir === undefined || !existing.editable) {
        event.res.status = 403
        return { error: `skills from source '${existing.source}' are read-only` }
      }
      skills.save(input, join(existing.dir, SKILL_FILE_NAME))
    }
    else {
      skills.save(input)
    }
    return { ok: true, name: input.name }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
