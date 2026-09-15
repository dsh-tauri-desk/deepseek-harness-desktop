import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

/** tmp+rename 落盘时对瞬时锁竞争（EPERM）的最大重试次数与退避延迟（ms）。 */
const RENAME_MAX_RETRIES = 8
const RENAME_RETRY_DELAY_MS = 25

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
