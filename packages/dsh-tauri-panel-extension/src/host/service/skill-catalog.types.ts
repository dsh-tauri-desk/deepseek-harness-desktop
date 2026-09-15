import type { HostSkill } from './skills.types'

export interface SkillRepositoryMetadata {
  id: string
  label: string
  kind: 'local' | 'git'
  githubUrl?: string
}

export type SkillRow = HostSkill & {
  editable: boolean
  removable: boolean
  dir?: string
  policyEditable: boolean
  repository?: SkillRepositoryMetadata
}
