import type { SkillInput } from './skills.types'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { defineService } from 'dsh-tauri'
import { SKILL_NAME_RE } from '../config/constants'
import { skillDir, skillFilePath } from '../utils/paths.utils'
import { rewriteSkillContent, serializeSkill } from './skills.utils'

export const skills = defineService({
  save(input: SkillInput, file?: string): string {
    if (file !== undefined) {
      writeFileSync(file, rewriteSkillContent(readFileSync(file, 'utf8'), input), 'utf8')
      return file
    }
    const target = skillFilePath(input.name)
    mkdirSync(skillDir(input.name), { recursive: true })
    writeFileSync(target, serializeSkill(input), 'utf8')
    return target
  },

  remove(name: string): boolean {
    if (!SKILL_NAME_RE.test(name))
      return false
    const dir = skillDir(name)
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      return false
    rmSync(dir, { recursive: true, force: true })
    return true
  },
})
