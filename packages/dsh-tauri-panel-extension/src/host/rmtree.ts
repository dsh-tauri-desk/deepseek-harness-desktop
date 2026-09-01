/**
 * Windows-hardened recursive delete for repository material. The skill
 * provider watches these trees live, and antivirus or search indexers
 * briefly hold handles onto freshly written files, so a plain rmSync
 * races open handles and dies with EPERM. Two mitigations: clear the
 * read-only attribute first (unlinking a read-only entry fails on
 * Windows), then retry the removal so short-lived locks run out.
 */

import type { Dirent } from 'node:fs'
import { chmodSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'pathe'

/** Windows lock holders usually let go within a second or two. */
const RETRIES = { maxRetries: 10, retryDelay: 200 } as const

function clearReadOnly(dir: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return // unreadable: rmSync will surface the real error
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    // Links read as neither file nor directory here; chmod would hit the
    // link TARGET (possibly the user's own folder), so they are skipped —
    // rmSync removes the link itself without following it.
    if (entry.isDirectory()) {
      try {
        chmodSync(child, 0o777)
      }
      catch {
        /* racing delete */
      }
      clearReadOnly(child)
    }
    else if (entry.isFile()) {
      try {
        chmodSync(child, 0o666)
      }
      catch {
        /* racing delete */
      }
    }
  }
  try {
    chmodSync(dir, 0o777)
  }
  catch {
    /* racing delete */
  }
}

/** Delete one directory tree (or lone file), tolerating Windows lock races. */
export function removeTree(path: string): void {
  try {
    clearReadOnly(path)
  }
  catch {
    // walk failure: rmSync reports the underlying error anyway
  }
  rmSync(path, { recursive: true, force: true, ...RETRIES })
}
