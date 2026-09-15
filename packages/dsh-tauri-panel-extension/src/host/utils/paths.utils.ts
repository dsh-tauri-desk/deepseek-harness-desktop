import { DSH_HOME } from 'dsh-tauri'
import { join } from 'pathe'
import { PROFILES_DIRECTORY, REPOS_DIRECTORY, SKILL_DATA_DIRECTORY, SKILL_FILE_NAME } from '../config/constants'

export function skillsDataDir(): string {
  return join(DSH_HOME, SKILL_DATA_DIRECTORY)
}

export function skillDir(name: string): string {
  return join(skillsDataDir(), name)
}

export function skillFilePath(name: string): string {
  return join(skillDir(name), SKILL_FILE_NAME)
}

export function materialDirFor(entryId: string): string {
  return join(skillsDataDir(), REPOS_DIRECTORY, entryId)
}

export function profileDir(profile: string): string {
  return join(DSH_HOME, PROFILES_DIRECTORY, profile)
}
