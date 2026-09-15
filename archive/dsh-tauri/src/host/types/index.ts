/**
 * dsh-tauri 宿主共享类型出口。
 * 【来源】HTTP 是桌面端自报协议；其余服务类型来自官方 @deepseek-ai d.ts。
 * 【版本】agent@0.1.0-rc.6；session/tools/workspace@0.1.0-rc.8。
 * 【修订】2026-01：收口 HostContext 与 HTTP fallback，均为 type-only。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type JsonBody = Record<string, unknown>
export type RouteResult = [number, unknown]
export type RouteFunction = (body: JsonBody, req: IncomingMessage) => Promise<RouteResult>
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
export interface ConnectionGate { requestRejection: (request: IncomingMessage) => 401 | 403 | undefined }
export interface HostRoute { kind: 'exact', path: string, handler: RouteHandler }
export interface AgentDefaultModelService { currentSelection?: () => ModelSelection | undefined }
export interface AgentPresetsService { mount?: (agentCtx: unknown, presetId: string) => Promise<unknown> | unknown }
export interface PermissionPresetsService { names: readonly string[], defaultPreset: string, optionOf: (name: string) => { value: string, name: string, description?: string }, set: (session: unknown, name: string) => void }
export interface WebServerService { register: (route: HostRoute) => () => void }
export interface ToolRegistrationService { register: (definition: ToolDefinition | unknown) => () => void | undefined }
export type HostContext = Context & { agents: AgentRegistry, sessions: SessionStore, workspaceRegistry: WorkspaceRegistry, tools: ToolRuntime & ToolRegistrationService, webServer: WebServerService, connection?: ConnectionGate, llm?: LlmRuntime, agentDefaultModel?: AgentDefaultModelService, agentPresets?: AgentPresetsService, permissionPresets?: PermissionPresetsService, loader: { import: (name: string) => Promise<unknown>, unwrapExports: (exports: unknown) => unknown } } & HostLifecycle

/** 宿主生命周期/注册表面（cordis Context 类型发布缺陷兜底：各插件 host/apply 共享）。 */
export interface HostLifecycle {
  effect: (callback: () => void | (() => void), id?: string) => void
  inject: (services: readonly string[], setup: (hostCtx: HostContext) => void) => void
  plugin: (plugin: unknown, config?: unknown) => unknown
  logger: { error: (message: string) => void }
}
export type { AgentRegistry, ContentBlock, LlmRuntime, ModelSelection, SessionStore, ToolDefinition, ToolRuntime, WorkspaceRegistry }
