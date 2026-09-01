/**
 * host/storage.ts — 旧版（v1）自持归档的持久化（新机制由宿主 WorkspaceRegistry
 * 持有归档集合；本文件只在启动迁移时读写旧 `archive.json`）。
 *
 * 适配 unstorage(fs)：读走 getItem（自动 JSON 解析），写经 dsh-tauri 的
 * createAtomicFsStorage（tmp+rename 原子写），读者永远看不到半份 JSON。
 */

import type { ArchiveDocument } from './types.js'
import { homedir } from 'node:os'
import process from 'node:process'
import { createAtomicFsStorage } from 'dsh-tauri'
import { join } from 'pathe'
import { SESSION_ARCHIVE_FILE, SESSION_STATE_DIRECTORY } from './constants.js'

/** The plugin's own state directory under DSH_HOME (default `~/.dsh`). */
export function sessionStateDir(dshHome?: string): string {
  return join(dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), SESSION_STATE_DIRECTORY)
}

function archiveStore(dshHome?: string) {
  return createAtomicFsStorage(sessionStateDir(dshHome))
}

/** Fresh empty archive document. */
export function emptyArchive(): ArchiveDocument {
  return {}
}

/** Load the archive; missing/corrupt files yield an empty archive. */
export async function loadArchive(dshHome?: string): Promise<ArchiveDocument> {
  try {
    const parsed = await archiveStore(dshHome).getItem<ArchiveDocument>(SESSION_ARCHIVE_FILE)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return emptyArchive()
    const out: ArchiveDocument = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Partial<{ sessionId: string, archivedAt: number }>
      if (typeof key === 'string' && typeof record?.sessionId === 'string' && key === record.sessionId)
        out[key] = record as ArchiveDocument[string]
    }
    return out
  }
  catch {
    return emptyArchive()
  }
}

/** Persist by atomic rename so readers never observe partial JSON. */
export async function saveArchive(archive: ArchiveDocument, dshHome?: string): Promise<void> {
  await archiveStore(dshHome).setItem(SESSION_ARCHIVE_FILE, `${JSON.stringify(archive, null, 2)}\n`)
}
