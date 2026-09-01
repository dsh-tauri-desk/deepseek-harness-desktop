/**
 * dsh-tauri-panel-extension 宿主侧（node half）：能力管理器。
 *
 * 三层目录（host / client / shared）：
 *   - index.ts（本文件）  public barrel（公开面不变：name/inject/apply + 能力函数）；
 *   - shared/constants    跨 half 协议常量（插件名 / API 前缀）；
 *   - host/               Node half：apply（装配 + provider 重挂载）、hooks
 *                        （hookable provider 钩子）、routes（领域路由组合）、
 *                        state（unstorage 状态持久化）、repos（ofetch GitHub 拉取）、
 *                        skills / mcp / agents / tar / opener / rmtree / profile /
 *                        restart（领域能力）、types / constants；
 *   - client/             Browser half（API 调用 + 设置页三个 tab）。
 */

import { PLUGIN_NAME } from './shared/constants.js'

/** 插件名（诊断元数据，与导出的 name 一致）。 */
export const name = PLUGIN_NAME

export const inject = ['webServer', 'skills', 'connection']

export { apply, loadFilesystemSkillPlugin, packagedSkillsDir } from './host/apply.js'
export type { Config } from './host/apply.js'
export { providerHooks } from './host/hooks.js'
export type { ProviderLifecycleHooks } from './host/hooks.js'
