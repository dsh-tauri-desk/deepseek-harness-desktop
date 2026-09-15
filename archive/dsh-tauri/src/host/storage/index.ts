/**
 * host/storage.ts — workspace 统一的宿主文件存储（unstorage fs driver + 原子写）。
 *
 * 唯一入口 `createAtomicFsStorage(featureDir)`：`featureDir` 是 DSH_HOME（默认 `~/.dsh`）
 * 下的功能目录名（如 `"crons"`），内部拼接 `$DSH_HOME/<featureDir>`；绝对路径原样使用。
 */

import type { Storage } from 'unstorage'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'

/** tmp+rename 落盘时对瞬时锁竞争（EPERM）的最大重试次数与退避延迟（ms）。 */
const RENAME_MAX_RETRIES = 8
const RENAME_RETRY_DELAY_MS = 25

/** 宿主数据根目录（优先使用 $DSH_HOME，默认 ~/.dsh）。 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * 以 tmp+rename 原子写覆盖 target；Windows 下目标被瞬时占用时按有界退避重试。
 * 独立导出以便单测锁定重试/原子性契约。
 */
export async function writeAtomic(target: string, value: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`

  try {
    await writeFile(temporary, value, 'utf8')
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, target)
        return
      }
      catch (error) {
        // 非锁语义的硬失败（非 EPERM/权限/不存在等）或超过重试次数时抛出
        if (attempt >= RENAME_MAX_RETRIES || (error as NodeJS.ErrnoException)?.code !== 'EPERM') {
          throw error
        }
        await sleep(RENAME_RETRY_DELAY_MS)
      }
    }
  }
  catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * 创建「原子写 + unstorage」的文件存储：key 即 base 下的相对路径。
 * @param featureDir DSH_HOME 下的功能目录名；绝对路径原样使用。
 */
export function createAtomicFsStorage(featureDir: string): Storage {
  const base = isAbsolute(featureDir) ? featureDir : join(DSH_HOME, featureDir)

  return createStorage({
    driver: {
      ...fsDriver({ base }),
      async setItem(key: string, value: string) {
        await writeAtomic(join(base, key.replace(/:/g, '/')), value)
      },
    },
  })
}
