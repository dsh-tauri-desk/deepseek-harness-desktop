/**
 * client/storage.ts — 浏览器端统一 key-value 存储（unstorage localStorage driver
 * 的单一入口）。
 *
 * 统一代码源：unstorage 这类客户端依赖**只由 dsh-tauri 的 client bundle 加载**，
 * 其他插件一律从 `dsh-tauri/client` 导入本模块的 `createLocalStorage`，不要再
 * 直接 import 'unstorage' —— 否则每个插件的 client bundle 都会内联一份重复代码。
 */

import { createStorage } from 'unstorage'
import localStorageDriver from 'unstorage/drivers/localstorage'

/** 插件客户端够用的 key-value 存储面（字符串值；getItem 自动 JSON 解析）。 */
export interface ClientStorage {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
}

/**
 * 创建浏览器 localStorage 存储：base 由 driver 拼成 `base:` 前缀，天然多插件隔离。
 * @param base 插件名（无冒号；driver 内部拼接 `base:`）。
 */
export function createLocalStorage(base: string): ClientStorage {
  const storage = createStorage({ driver: localStorageDriver({ base }) })
  return {
    getItem: key => storage.getItem(key) as Promise<string | null>,
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: key => storage.removeItem(key),
  }
}
