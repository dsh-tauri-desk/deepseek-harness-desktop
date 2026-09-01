/**
 * slots.d.ts — 本插件的类型增广（模块文件：含 import，故仅对**可解析**的
 * 模块做增广）。
 *
 * 目标：零新增依赖仍获得类型检查。此处只增广 '@deepseek-ai/cordis'（该包在
 * 插件 node_modules 根下可解析）：locale 服务的非类型化表面来自
 * dsh-client-locale 包（不在本插件类型图），按我们实际用到的子集声明。
 *
 * 注：'sidebar.panel.action' / 'conversation' 的 SlotMap 声明归属 ui-layout /
 * ui-sidebar（不在本插件类型图、未提升到根 node_modules），无法在保留模块
 * 同一性的前提下在此增广——注册处改用显式 cast（先例：dsh-tauri-ui 的
 * trigger.tsx、dsh-tauri-panel 的 sidebar.tsx）。组件 props 仍由本地
 * 接口提供类型。
 *
 * 本文件必须保持**模块身份**（末尾 `export {}` 维持；lint --fix 不会删除
 * export）：脚本文件里的 declare module 是环境模块声明，会遮蔽同名真实模块
 * （连带吞掉 effect 等成员）；模块文件里才是增广语义，与真实 cordis Context 合并。
 */
declare module '@deepseek-ai/cordis' {
  /** locale 服务的非类型化表面（本插件用到的子集；typed 表面在 dsh-client-locale）。 */
  interface DshLocaleRuntimeLike {
    register: (ns: string, locale: string, dict: Record<string, string>) => () => void
    getLocale: () => { active: string, revision: number }
    getSnapshot: () => { active: string, revision: number }
    subscribe: (fn: () => void) => () => void
  }

  interface Context {
    locale: DshLocaleRuntimeLike
  }
}
export {}
