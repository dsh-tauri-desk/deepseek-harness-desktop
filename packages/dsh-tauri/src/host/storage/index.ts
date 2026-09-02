/**
 * host/storage.ts — unstorage fs 适配器 + 原子写恢复（插件 JSON 状态的统一持久化）。
 *
 * 为什么在这里：worktree 的 ledger / checkout-context、session 的旧版归档、panel-extension
 * 的 state.json 都需要「小 JSON 文件 + 原子写」的同一形态；按 unconfig 的抽离标准
 * （≥2 个真实消费者、API 稳定、可独立测试）抽到 dsh-tauri 宿主共享。
 *
 * 为什么包原子写：unstorage 的 fs driver `setItem` 是直接 writeFile，读者可能读到
 * 半份 JSON；本项目既有保证是 tmp+rename（临时文件写全后原子改名）。这里以自定义
 * driver 组合 fs driver：读/枚举/watch 语义不变，写路径恢复原子保证。
 *
 * 为什么对 rename 做带退避的重试：Windows 下「tmp 写全后 rename 覆盖目标文件」的原子
 * 写法并不稳定——Node 的 rename 底层用 MoveFileEx(MOVEFILE_REPLACE_EXISTING)，当目标
 * 文件正被另一个句柄打开（未共享删除访问，典型如同步读面 loadLedgerSync 尚未关闭，
 * 或上一次写仍在收尾）时会以 EPERM 失败；句柄释放后重试即成功，正好匹配「工作树
 * 偶尔失败、点多几次就好」的现象。这里用有界退避重试覆盖这种瞬时锁竞争，同时保留
 * tmp+rename 的原子语义（读者永远看不到半份 JSON）。非 Windows 平台 rename 覆盖是
 * 原子的，补偿很小，故不按平台分支。
 */

import type { Storage } from 'unstorage'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'

/** fs driver 的可写子面（setItem 替换点）。 */
type FsDriverShape = ReturnType<typeof fsDriver>

/** tmp+rename 落盘时对瞬时锁竞争（EPERM）的最大重试次数。 */
const RENAME_MAX_RETRIES = 8
/** 每次重试前的退避延迟（毫秒）。 */
const RENAME_RETRY_DELAY_MS = 25

/**
 * 以 tmp+rename 原子写覆盖 target；Windows 下目标被瞬时占用时按有界退避重试。
 *
 * 独立导出以便单测锁定重试/原子性契约（包公开面仍只有 createAtomicFsStorage）。
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
        // 非锁语义的硬失败（权限/不存在/来源消失等）直接抛出，不吞掉。
        if (attempt >= RENAME_MAX_RETRIES || !isRenameLockError(error))
          throw error
        await sleep(RENAME_RETRY_DELAY_MS)
      }
    }
  }
  catch (error) {
    // 覆盖失败时清理残留临时文件；unlink 失败可忽略（可能已被删/权限变化）。
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/** 是否为「目标被占用」一类的瞬时 rename 失败（平台相关的 EPERM）。 */
function isRenameLockError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
  return false
}

/**
 * 创建「原子写 + unstorage」的文件存储：key 即 base 下的相对路径。
 * 调用方写入时传对象或预序列化字符串均可；getItem 自动 JSON.parse。
 * @param base 存储根目录（不存在时按需创建）。
 * @returns unstorage Storage（键为相对路径）。
 */
export function createAtomicFsStorage(base: string): Storage {
  const driver: FsDriverShape = {
    ...fsDriver({ base }),
    async setItem(key: string, value: string) {
      await writeAtomic(join(base, key), value)
    },
  }
  return createStorage({ driver })
}
