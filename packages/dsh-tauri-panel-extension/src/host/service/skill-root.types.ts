export interface SkillRootEntry {
  id: string
  kind: 'local' | 'git'
  label: string
  url?: string
  ref?: string
  path?: string
  roots: string[]
  materialDir?: string
  addedAt: number
}

export interface PluginState {
  skillRoots: SkillRootEntry[]
}

export type SkillRootView = SkillRootEntry & { live: boolean }
