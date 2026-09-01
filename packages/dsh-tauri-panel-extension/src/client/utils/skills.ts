/**
 * lib/skills.ts — 技能列表展示的纯函数（无 DOM、无 React、无副作用）。
 * 从 skills-tab.tsx 剥离，便于单测与复用。
 */

import type { SkillRowView } from '../types'
import { GITHUB_REPOSITORY_PATTERN } from '../constants'

export function policyTag(skill: SkillRowView): { key?: string, off: boolean } {
  const { modelInvocable, userInvocable } = skill.invocation
  if (!modelInvocable && !userInvocable)
    return { key: 'skillDisabled', off: true }
  if (!modelInvocable)
    return { key: 'skillUserOnly', off: false }
  if (!userInvocable)
    return { key: 'skillModelOnly', off: false }
  return { off: false }
}

export function normalizeRepository(value: string): string | null {
  const normalized = value.trim().replace(/\/$/, '')
  if (!GITHUB_REPOSITORY_PATTERN.test(normalized))
    return null
  return normalized.startsWith('http') ? normalized : `https://github.com/${normalized}`
}
