/**
 * Host 运行时由 DSH 提供的最小编译期声明（对齐 MichengAI/dsh-automation 的 src/types/dsh.d.ts）。
 *  不引入任何 @deepseek-ai/dsh-* 运行时依赖 —— 这些模块由宿主在运行时解析。
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    readonly agent?: any
    readonly agents: any
    readonly agentDefaultModel: any
    readonly agentPresets: any
    readonly permissionPresets: import('../host/service/permission-presets.ts').PermissionPresetService
    readonly sessions: any
    readonly sessionTitle?: { rename: (session: unknown, title: string) => unknown }
    readonly workspaceRegistry: any
    readonly storageDomain: any
    readonly connection: any
    readonly tools: any
    readonly llm?: any
    readonly systemPrompt?: { section: (input: { name: string, order: number, text: string }) => () => void }
    readonly logger: { warn: (message: string) => void }
    effect: <T>(factory: () => T | Promise<T>, label?: string) => T
    on: (name: string, listener: (...args: any[]) => any) => () => void
    get: (name: string) => unknown
  }
}

declare module '@deepseek-ai/schemastery' {
  const z: any
  export default z
}

declare module '@deepseek-ai/dsh-agent' {
  export interface ModelSelection {
    provider: string
    model: string
    reasoningEffort?: string
  }
  export function installModelSelection(agentCtx: unknown, selection: {
    current: ModelSelection | undefined
    assembled: ModelSelection | undefined
  }): () => void
}

declare module '@deepseek-ai/dsh-agent-default-model' {}
declare module '@deepseek-ai/dsh-agent-presets' {}
declare module '@deepseek-ai/dsh-permission-presets' {}
declare module '@deepseek-ai/dsh-client-connection' {}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  export function Toast(props: { text: string, icon?: ReactNode, anchor?: HTMLElement | null, onDone: () => void }): JSX.Element
  export function Menu(props: { open: boolean, onClose: () => void, items: readonly any[], onSelect: (id: string) => void, selectedId?: string, portal?: boolean, align?: string, side?: string, anchor: ReactNode }): JSX.Element
  export function Modal(props: any): JSX.Element
  export function IconWarningOutline16(): JSX.Element
}

declare module '@deepseek-ai/dsh-llm' {
  export function createUserMessage(value: {
    content: readonly { type: 'text', text: string }[]
    source: unknown
  }): unknown
}

declare module '@deepseek-ai/dsh-session' {
  export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
  export type SessionId = string & { readonly __sessionId: unique symbol }
  export function SessionId(value: string): SessionId
}

declare module '@deepseek-ai/dsh-user-approval' {
  export function setApprovalPolicy(session: unknown, policy: 'ask' | 'never'): void
}

declare module '@deepseek-ai/dsh-workspace' {
  export type WorkspaceId = string & { readonly __workspaceId: unique symbol }
  export function WorkspaceId(value: string): WorkspaceId
}

declare module '@deepseek-ai/dsh-storage-domain' {
  import type { ZodType } from 'zod'

  export interface DomainSpec {
    readonly name: string
    readonly version: number
    readonly tables: Record<string, { readonly valueSchema: ZodType }>
  }
  export function defineDomain<S extends DomainSpec>(spec: S): S
  export function domainTable<K extends string, V>(schema: ZodType<V>): {
    readonly valueSchema: ZodType<V>
    readonly __key?: K
  }
  export interface KvTable<K extends string, V> {
    get: (key: K) => V | undefined
    entries: () => IterableIterator<[K, V]>
    keys: () => IterableIterator<K>
    readonly size: number
    put: (key: K, value: V) => Promise<void>
    delete: (key: K) => Promise<boolean>
    update: (key: K, transform: (current: V) => V) => Promise<V>
  }
  export interface Domain<S> {
    readonly name: string
    table: (name: string) => KvTable<string, any>
    close: () => Promise<void>
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export type { JsonValue } from '@deepseek-ai/dsh-session'
  export interface ToolRunContext {
    readonly signal: AbortSignal
    readonly agent?: { readonly id: string }
  }
  export interface ToolExecution {
    readonly name: string
    readonly arguments: unknown
  }
  export function defineTool(definition: any): any
}

declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react'

  export function createPortal(children: ReactNode, container: Element | DocumentFragment): ReactPortal
}
