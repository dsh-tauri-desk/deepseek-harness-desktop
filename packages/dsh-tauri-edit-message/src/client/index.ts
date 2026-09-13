/**
 * client/index.ts — 编辑消息插件的浏览器装配入口。
 *
 * 只做 import + 组装：
 *   1. 运行时句柄：把 sessions 服务交给 DOM 层（既用于定位当前会话，也用于提交后导航）；
 *   2. DOM 注入：在官方用户气泡上**只追加** Edit 按钮与编辑面板，官方气泡本体由
 *      内核渲染、插件绝不接管 `conversation.chat.node`；
 *   3. 会话列表变化时清理注入（页面切换后行会被重建，观察器负责补回）。
 *
 * 依赖纪律：本目录**不静态引用任何 `@deepseek-ai/*` 包**——client bundle 在 dsh Web
 * ModuleLoader 的 factory 里运行，模块表只认识平台种子（react）与已加载的链接模块，
 * 引用了不存在的 specifier 会让 loader 整棵树失败（界面白屏）。允许的 bare import
 * 只有 react / dsh-tauri/client / dsh-tauri-ui/client。样式一律走 css-render 节点，
 * 不注入 `<style>`、不写 style.textContent。
 */

import type { ClientContext } from 'dsh-tauri/client'
import type { SessionsService } from './types'
import { installMessagePatch } from './dom/install-patch'
import { setSessionsService } from './dom/runtime'

/** 插件显示名（诊断元数据）。 */
export const name = 'dsh-tauri-edit-message'

/** 需要的客户端服务：sessions（DOM 注入本身只依赖 DOM 与同源 HTTP）。 */
export const inject = ['sessions']

/**
 * 插件体：装配运行时句柄与 DOM 注入。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  // 反射取服务（ClientContext 契约不含 get，因此经 unknown 断言；同时不读
  // ctx.<service> 属性，避免 cordis 的 inject-only 属性守卫让整个 loader entry 失败）。
  const reflector = ctx as unknown as { get?: (name: string) => unknown }
  const sessions = (typeof reflector.get === 'function' ? reflector.get('sessions') : undefined) as SessionsService | undefined
  setSessionsService(sessions ?? null)

  if (!sessions || typeof sessions.open !== 'function') {
    // 没有导航服务也照常注入：编辑仍会重建会话，只是提交后无法自动跳过去。
    console.warn('[dsh-tauri-edit-message] 缺少会话导航服务（sessions.open），提交编辑后无法自动打开新会话。')
  }

  ctx.effect((): void | (() => void) => installMessagePatch())
}
