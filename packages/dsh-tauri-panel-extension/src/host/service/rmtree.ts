import type { Dirent } from 'node:fs'
import { chmodSync, readdirSync, rmSync } from 'node:fs'
import { defineService } from 'dsh-tauri'
import { join } from 'pathe'
import { RMTREE_RETRIES } from '../config/constants'

export const rmtree = defineService({
  remove(path: string): void {
    try {
      clearReadOnly(path)
    }
    catch {}
    rmSync(path, { recursive: true, force: true, ...RMTREE_RETRIES })
  },
})

// --- internal ---

function clearReadOnly(dir: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      try {
        chmodSync(child, 0o777)
      }
      catch {}
      clearReadOnly(child)
    }
    else if (entry.isFile()) {
      try {
        chmodSync(child, 0o666)
      }
      catch {}
    }
  }
  try {
    chmodSync(dir, 0o777)
  }
  catch {}
}
