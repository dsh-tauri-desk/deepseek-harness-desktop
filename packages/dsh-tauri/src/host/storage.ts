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
 */

import type { Storage } from 'unstorage'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'

/** fs driver 的可写子面（setItem 替换点）。 */
type FsDriverShape = ReturnType<typeof fsDriver>

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
      const target = join(base, key)
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, value, 'utf8')
      await rename(temporary, target)
    },
  }
  return createStorage({ driver })
}
