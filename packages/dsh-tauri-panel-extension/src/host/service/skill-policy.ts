import { readFileSync, writeFileSync } from 'node:fs'
import { defineService } from 'dsh-tauri'
import { rewriteSkillPolicy } from './skills.utils'

export const skillPolicy = defineService({
  save(file: string, enabled: boolean): void {
    writeFileSync(file, rewriteSkillPolicy(readFileSync(file, 'utf8'), enabled), 'utf8')
  },
})
