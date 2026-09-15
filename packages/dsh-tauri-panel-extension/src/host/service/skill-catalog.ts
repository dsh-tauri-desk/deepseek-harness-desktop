import type { SkillRepositoryMetadata, SkillRow } from './skill-catalog.types'
import type { SkillRootEntry } from './skill-root.types'
import type { HostSkill, HostSkillDefinition } from './skills.types'
import { defineService } from 'dsh-tauri'
import { orderBy } from 'lodash-es'
import { isAbsolute, relative, resolve, sep } from 'pathe'
import { getCurrentHostInstance } from '../config/runtime'
import { skillsDataDir } from '../utils/paths.utils'
import { skillRoot } from './skill-root'

export const skillCatalog = defineService({
  async resolve(): Promise<SkillRow[]> {
    const skills = await getCurrentHostInstance().skills.list()
    const entries = await skillRoot.list()
    const rows = await Promise.all(skills.map(skill => toSkillRow(skill, entries)))
    return orderBy(rows, [row => row.repository === undefined], ['asc'])
  },

  async peek(name: string): Promise<HostSkillDefinition | null> {
    return (await getCurrentHostInstance().skills.get(name)) ?? null
  },
})

// --- internal ---

async function customSkillWritable(dir: string): Promise<boolean> {
  const state = skillsDataDir()
  if (dir === state || dir.startsWith(state + sep))
    return true
  return (await skillRoot.list()).some(entry =>
    entry.roots.some(root => dir === root || dir.startsWith(root + sep)))
}

async function skillWritable(skill: HostSkill, dir: string | undefined): Promise<boolean> {
  if (dir === undefined)
    return false
  if (skill.source === 'user-dsh')
    return true
  return skill.source === 'custom' && await customSkillWritable(dir)
}

function pathWithin(path: string, parent: string): boolean {
  const child = resolve(path)
  const root = resolve(parent)
  const nested = relative(root, child)
  return nested === '' || (!nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested))
}

function repositoryForSkill(
  skill: HostSkill,
  entries: SkillRootEntry[],
): SkillRepositoryMetadata | undefined {
  const dir = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : undefined
  if (dir === undefined)
    return undefined
  const entry = entries.find(candidate => candidate.roots.some(root => pathWithin(dir, root)))
  if (entry === undefined)
    return undefined
  return {
    id: entry.id,
    label: entry.label,
    kind: entry.kind,
    ...(entry.kind === 'git' && entry.url !== undefined ? { githubUrl: entry.url } : {}),
  }
}

async function toSkillRow(skill: HostSkill, entries: SkillRootEntry[]): Promise<SkillRow> {
  const dir = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : undefined
  const repository = repositoryForSkill(skill, entries)
  return {
    ...skill,
    editable: await skillWritable(skill, dir),
    removable: skill.source === 'user-dsh',
    ...(dir !== undefined ? { dir } : {}),
    policyEditable: dir !== undefined,
    ...(repository !== undefined ? { repository } : {}),
  }
}
