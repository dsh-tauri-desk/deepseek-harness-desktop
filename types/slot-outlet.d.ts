/**
 * Ambient 声明：renderer 补丁在运行时追加到 @deepseek-ai/dsh-client-ui-renderer
 * 的 <SlotOutlet> 导出（安装包 d.ts 未声明，补丁随桌面壳发布）。
 * 消费方（dsh-tauri-panel / dsh-tauri-ui）必须先 `typeof SlotOutlet === 'function'`
 * 探测再使用：无补丁的旧核心下值为 undefined，整体降级为官方 UI，绝不白屏。
 * 各插件 tsconfig 统一 include ../../types 下的本文件。
 */

declare module '@deepseek-ai/dsh-client-ui-renderer' {
  import type { ComponentType, ReactNode } from 'react'

  /** 任意槽渲染入口（契约见 dsh-tauri-panel PROTOCOL.md）。 */
  export const SlotOutlet: ComponentType<{
    slotKey: string
    ownerProps?: Record<string, unknown>
    opts?: { only?: string, fallback?: ReactNode }
  }> | undefined
}

export {}
