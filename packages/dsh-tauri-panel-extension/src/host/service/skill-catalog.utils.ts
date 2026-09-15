import type { SkillRootEntry, SkillRootView } from './skill-root.types'
import { directoryExists } from '../utils/filesystem.utils'

export function rootView(entry: SkillRootEntry): SkillRootView {
  return { ...entry, live: entry.roots.every(root => directoryExists(root)) }
}
