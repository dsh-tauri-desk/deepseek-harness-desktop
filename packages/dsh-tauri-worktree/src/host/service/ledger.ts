import type { Binding } from '../types'
import { readdirSync, readFileSync } from 'node:fs'
import { defineService, DSH_HOME } from 'dsh-tauri'
import { compact, filter, isPlainObject } from 'lodash-es'
import { join } from 'pathe'
import { LEDGER_DIR } from '../config/constants'
import { storage } from '../storage'

export const ledger = defineService({
  load(sessionId: string): Binding | null {
    return readBinding(join(DSH_HOME, keyOf(sessionId)))
  },

  async save(sessionId: string, binding: Binding): Promise<void> {
    await storage.setItem(keyOf(sessionId), `${JSON.stringify(binding, null, 2)}\n`)
  },

  async remove(sessionId: string): Promise<void> {
    await storage.removeItem(keyOf(sessionId))
  },

  list(): Binding[] {
    const dir = join(DSH_HOME, LEDGER_DIR)
    return compact(readJsonNames(dir).map(name => readBinding(join(dir, name))))
  },
})

// --- internal ---

function keyOf(sessionId: string): string {
  return `${LEDGER_DIR}/${sessionId}.json`
}

function readJsonNames(dir: string): string[] {
  try {
    return filter(readdirSync(dir), name => name.endsWith('.json'))
  }
  catch {
    return []
  }
}

function readBinding(path: string): Binding | null {
  try {
    return parseBinding(readFileSync(path, 'utf8'))
  }
  catch {
    return null
  }
}

function parseBinding(raw: string): Binding | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed as Binding : null
  }
  catch {
    return null
  }
}
