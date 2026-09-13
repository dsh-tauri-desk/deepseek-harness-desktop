/**
 * tsdown.config.ts — 本插件两半的构建入口。
 *
 * 只有 `defineDshConfig()` 一行：host entry = src/index.ts（ESM → dist/index.js），
 * client entry = src/client/index.ts（CJS + ModuleLoader 包装 → dist/client.cjs）。
 * 与 packages/ 下所有内置插件一致；缺少本文件时 tsdown 会退回默认配置产出
 * dist/index.mjs，而 package.json 的 exports/main 指向 dist/index.js，运行时会
 * `Cannot find module .../dist/index.js`，插件整棵树加载失败。
 */
import { defineDshConfig } from 'dsh-tauri-tsdown'

export default defineDshConfig()
