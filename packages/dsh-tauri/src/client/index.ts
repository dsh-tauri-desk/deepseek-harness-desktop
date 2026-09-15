export * from './controller'

export * from './hooks/use-invoke'
export * from './hooks/use-listen'
export * from './hooks/use-listen-parent'

export * from './locale'

export * from './modules/css-render'
export * from './modules/date-fns'
export * from './modules/hookable'
export * from './modules/lodash-es'
export * from './modules/reause'
export * from './modules/unstorage'
export * from './modules/valtio-define'

export * from './panel'
export * from './register'
export * from './request'

export * from './service/invoke'
export * from './service/invoke-parent'
export * from './service/listen'
export * from './service/listen-parent'

export type * from './types/adapter'
export type * from './types/bridge'
export type * from './types/harness'
export type * from './types/iframe'
export type * from './types/tauri'

export const name = 'dsh-tauri'

// 纯库形态的客户端入口同样必须导出插件条目：DSH web loader 只接受函数或带 `apply` 的对象。
export function apply(): void {}
