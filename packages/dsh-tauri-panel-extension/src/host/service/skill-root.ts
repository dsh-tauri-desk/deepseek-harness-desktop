import type { PluginState, SkillRootEntry } from './skill-root.types'
import { defineService } from 'dsh-tauri'
import { STATE_FILE_NAME } from '../config/constants'
import { storage } from '../storage'

export const skillRoot = defineService({
  async load(url: string): Promise<SkillRootEntry | null> {
    return (await readAll()).find(entry => entry.url === url) ?? null
  },

  async list(): Promise<SkillRootEntry[]> {
    return readAll()
  },

  async save(entry: Omit<SkillRootEntry, 'addedAt'>): Promise<SkillRootEntry> {
    const skillRoots = await readAll()
    const stored: SkillRootEntry = { ...entry, addedAt: Date.now() }
    skillRoots.push(stored)
    await writeAll(skillRoots)
    return stored
  },

  async remove(id: string): Promise<SkillRootEntry | null> {
    const skillRoots = await readAll()
    const at = skillRoots.findIndex(entry => entry.id === id)
    if (at === -1)
      return null
    const [removed] = skillRoots.splice(at, 1)
    await writeAll(skillRoots)
    return removed
  },
})

// --- internal ---

async function readAll(): Promise<SkillRootEntry[]> {
  const parsed = await storage.getItem<Partial<PluginState>>(STATE_FILE_NAME)
  if (!Array.isArray(parsed?.skillRoots))
    return []
  return parsed.skillRoots.filter(isSkillRootEntry)
}

async function writeAll(skillRoots: SkillRootEntry[]): Promise<void> {
  await storage.setItem(STATE_FILE_NAME, `${JSON.stringify({ skillRoots }, null, 2)}\n`)
}

function isSkillRootEntry(entry: unknown): entry is SkillRootEntry {
  if (typeof entry !== 'object' || entry === null)
    return false
  const candidate = entry as Record<string, unknown>
  return typeof candidate.id === 'string' && Array.isArray(candidate.roots)
}
