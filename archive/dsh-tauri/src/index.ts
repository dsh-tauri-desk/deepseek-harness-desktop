/**
 * dsh-tauri 宿主侧（node half）：共享 HTTP 路由工具 / 系统打开 / 原子文件存储。
 *
 * 目录规划（host/client 三层）：
 *   - index.ts（本文件）  public barrel：宿主全部公开面（HTTP 契约 + openUrl + 存储设施）；
 *   - host/utils/http.ts   路由工具（鉴权包装 / JSON 体 / routeHandler）；
 *   - host/service/open.ts 系统默认方式打开 URL；
 *   - host/storage/        unstorage(fs) 原子写存储（插件 JSON 状态共享设施）；
 *   - host/apply.ts      空插件入口（loader 挂载用）；
 *   - client/            浏览器半区（导航桥插件 + 共享客户端工具，见其 index.ts）。
 *
 * 本包是全 workspace 的 base：插件宿主模块从本 barrel 导入路由工具，插件客户端
 * 从 `dsh-tauri/client` 导入共享工具（compat/store/http/lifecycle/CssRender）。
 */

export { apply } from './host/apply'
export * from './host/service/open'
export * from './host/storage'
export * from './host/types'
export * from './host/utils/http'
export type { Context } from '@deepseek-ai/cordis'
export type { AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
export type { ContentBlock, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
export type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
export type { ToolDefinition, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
export type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
