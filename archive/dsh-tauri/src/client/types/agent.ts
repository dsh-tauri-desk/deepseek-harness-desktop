/**
 * 官方 Agent/Tools 类型统一客户端出口。
 * 【来源】@deepseek-ai/dsh-agent、@deepseek-ai/dsh-tools 官方 d.ts。
 * 【版本】dsh-agent@0.1.0-rc.6；dsh-tools@0.1.0-rc.8。
 * 【修订】2026-01：新增 dsh-tauri type-only 出口，运行时仍由 loader 注入。
 */
export type { ModelSelection } from '@deepseek-ai/dsh-agent'
export type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
