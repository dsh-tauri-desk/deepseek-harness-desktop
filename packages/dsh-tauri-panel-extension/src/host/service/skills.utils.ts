import type { SkillInput } from './skills.types'
import { isEmpty } from 'lodash-es'
import {
  SKILL_CONTENT_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_RE,
  SKILL_WHEN_TO_USE_MAX_LENGTH,
} from '../config/constants'

export function serializeSkill(input: SkillInput): string {
  const lines = [
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
  ]
  if (!isEmpty(input.whenToUse))
    lines.push(`whenToUse: ${JSON.stringify(input.whenToUse)}`)
  if (!input.modelInvocable)
    lines.push('disable-model-invocation: true')
  if (!input.userInvocable)
    lines.push('user-invocable: false')
  const body = input.content.replace(/\r\n/g, '\n').trim()
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`
}

export function validateSkillInput(input: SkillInput): string | null {
  if (!SKILL_NAME_RE.test(input.name))
    return 'name must be kebab-case (a-z, 0-9, dashes)'
  if (input.description.trim() === '')
    return 'description is required'
  if (input.description.length > SKILL_DESCRIPTION_MAX_LENGTH)
    return `description too long (max ${SKILL_DESCRIPTION_MAX_LENGTH})`
  if ((input.whenToUse?.length ?? 0) > SKILL_WHEN_TO_USE_MAX_LENGTH)
    return `whenToUse too long (max ${SKILL_WHEN_TO_USE_MAX_LENGTH})`
  if (input.content.length > SKILL_CONTENT_MAX_BYTES)
    return 'content too large (max 256 KiB)'
  return null
}

export function rewriteSkillContent(text: string, input: SkillInput): string {
  const { newline, lines } = frontmatterOf(text)
  const kept = lines.filter(line => !/^(?:name|description|whenToUse|disable-model-invocation|user-invocable):/.test(line))
  const head = [`name: ${input.name}`, `description: ${JSON.stringify(input.description)}`]
  if (!isEmpty(input.whenToUse))
    head.push(`whenToUse: ${JSON.stringify(input.whenToUse)}`)
  if (!input.modelInvocable)
    kept.push('disable-model-invocation: true')
  if (!input.userInvocable)
    kept.push('user-invocable: false')
  const body = input.content.replace(/\r\n/g, '\n').trim()
  return `---${newline}${[...head, ...kept].join(newline)}${newline}---${newline}${newline}${body}${newline}`
}

export function rewriteSkillPolicy(text: string, enabled: boolean): string {
  const { newline, lines, body } = frontmatterOf(text)
  const kept = lines.filter(line => !/^(?:disable-model-invocation|user-invocable):/.test(line))
  if (!enabled)
    kept.push('disable-model-invocation: true', 'user-invocable: false')
  return `---${newline}${kept.join(newline)}${newline}---${body}`
}

// --- internal ---

function frontmatterOf(text: string): { newline: string, lines: string[], body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null)
    throw new Error('skill file has no frontmatter block')
  return {
    newline: text.includes('\r\n---') ? '\r\n' : '\n',
    lines: match[1].split(/\r?\n/),
    body: text.slice(match[0].length),
  }
}
