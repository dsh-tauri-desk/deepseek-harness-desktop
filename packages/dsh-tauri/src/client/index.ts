/**
 * dsh-tauri 客户端 barrel（browser half）：插件入口 + 全 workspace 客户端共享工具。
 *
 * 共享工具（供各插件 client 导入 `dsh-tauri/client`）：
 *   - compat / resolveStartSession：Alpha ↔ rc.2 服务布局适配；
 *   - store：框架无关 SnapshotStore（uSES 安全）；
 *   - fetch：ofetch 统一 JSON 客户端（错误解析内置，唯一导出）；
 *   - storage：unstorage createStorage / localStorageDriver；
 *   - controller：hookable 生命周期控制器（observer/timer/listener 收敛）；
 *   - CssRender：css-render 样式树（各插件 mount*Styles 使用）。
 *
 * 父窗口桥（iframe ↔ 桌面宿主）**唯一入口**，自定义桥一律用这几个：
 *   - `invoke`：调用宿主侧的 Tauri command（签名同 `@tauri-apps/api/core`）；
 *   - `listen`：订阅宿主转发进来的 Tauri 事件（签名同 `@tauri-apps/api/event`）；
 *   - `invokeParent` / `listenParent`：自定义协议的裸收发原语；
 *   - `useInvoke` / `useListen` / `useListenParent`：上面三者的 React 版本。
 */
import { PLUGIN_ID, PLUGIN_INJECT } from './constants'

/** 插件显示名（诊断元数据）。 */
export const name = PLUGIN_ID

/** 需要的客户端服务：layout（侧边栏切换）。 */
export const inject = PLUGIN_INJECT

export * from './apis'
export { apply } from './apply'
export * from './controller'
export { useInvoke } from './hooks/use-invoke'
export type { UseInvokeResult } from './hooks/use-invoke'
export { useListen } from './hooks/use-listen'
export { useListenParent } from './hooks/use-listen-parent'
export { invoke } from './service/invoke'
export { invokeParent } from './service/invoke-parent'
export type { InvokeParentResult } from './service/invoke-parent'
export { listen } from './service/listen'
export { listenParent } from './service/listen-parent'
export * from './storage'
export * from './store'

export type * from './types'

export type { ClientContext } from './types'
export { compat, resolveStartSession } from './utils/compat'
export { CssRender } from 'css-render'

/** 仅构建期 tree-shake 内联所用导出；date-fns 不进入 release production 资源闭包。 */
export { differenceInDays, differenceInHours, differenceInMinutes, format } from 'date-fns'

export { createHooks } from 'hookable'
