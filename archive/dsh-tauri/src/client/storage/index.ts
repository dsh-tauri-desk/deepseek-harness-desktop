/**
 * client/storage.ts — 浏览器端统一 key-value 存储（unstorage）。
 *
 * 统一代码源：unstorage 这类客户端依赖**只由 dsh-tauri 的 client bundle 加载**，
 * 本模块只 re-export `createStorage` 与 `localStorageDriver`；各插件自定义
 * `const storage = createStorage({ driver: localStorageDriver({ base: PLUGIN_ID }) })`
 * 并统一用 `storage.setItem/getItem/removeItem`，不再 import 'unstorage'。
 */

export { createStorage } from 'unstorage'
export { default as localStorageDriver } from 'unstorage/drivers/localstorage'
