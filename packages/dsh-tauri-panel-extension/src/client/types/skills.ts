/** types/skills.ts — 技能管理领域类型（SkillsTab 相关）。 */

import type { Translate } from './protocol'

export interface SkillRepositoryView {
  id: string
  label: string
  kind: 'local' | 'git'
  githubUrl?: string
}

export interface SkillRowView {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean, userInvocable: boolean }
  source: string
  editable: boolean
  removable: boolean
  dir?: string
  policyEditable: boolean
  repository?: SkillRepositoryView
}

export interface SkillEditorState {
  mode: 'edit' | 'view'
  name: string
  description: string
  whenToUse: string
  modelInvocable: boolean
  userInvocable: boolean
  content: string
}

export type OpenTarget = { target: 'user-skills' } | { target: 'skill', name: string }

export interface SkillsInjected {
  list: () => Promise<{ skills: SkillRowView[] }>
  get: (name: string) => Promise<{ content: string }>
  save: (input: Record<string, unknown>) => Promise<{ ok: boolean }>
  remove: (name: string) => Promise<{ ok: boolean }>
  policy: (name: string, enabled: boolean) => Promise<{ ok: boolean }>
  open: (target: OpenTarget) => Promise<{ ok: boolean }>
  importRepository: (url: string) => Promise<{ ok: boolean }>
}

export interface SkillsTabProps {
  t: Translate
  injected: SkillsInjected
  createSkill: () => Promise<void>
}
