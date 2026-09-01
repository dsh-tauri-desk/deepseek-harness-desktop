/**
 * register/panel-service.ts — 面板协议宿主服务装配（panel.protocol）。
 *
 * 协议能力见 PROTOCOL.md。机制（全部在宿主，单一权威）：
 *   - 服务经 ctx.reflect.provide('panel.protocol', api) 暴露（cordis
 *     ReflectService，官方 runtime 同款用法 ctx.reflect.provide("sessions", this)）；
 *   - renderPanelContent：conversation 槽（single/session-maybe，layout 声明、
 *     官方 ui-conversation priority 0 是唯一注册者）以 priority -1 **动态注册**
 *     → 整个右侧会话区被替换（CenterColumn 内、零定位层）；官方条目被
 *     shadow 但仍 live（children/locale 有效）。再调（同 id）→ dispose 句柄
 *     → 官方恢复（toggle 语义）。
 *   - 不能常驻注册 + SlotOutlet 透传：SlotOutlet 对 single 槽只渲染 live 条目，
 *     自己 live 后渲染官方条目 = 自递归（无公开 API 渲染被 shadow 条目）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PanelProtocol } from '../types'
import { PanelActionItem } from '../components/action-item'
import { PANEL_PROTOCOL_SERVICE } from '../constants'
import { createPanelConversationController } from '../service/controller'

/**
 * 安装宿主服务：经 ctx.reflect.provide 暴露 panel.protocol（effect 生命周期，
 * 插件卸载即注销）。不依赖 renderer 补丁（conversation 注册只走 slots
 * runtime）——旧核心下内容区替换仍可用（仅面板区条目需 renderer）。
 *
 * 协议方法（含方案 C 可选能力）：既有三方法原样；`setPanelWidth` /
 * `resetPanelWidth` / `getPanelWidth` 委托宽度控制器（始终提供——控制器内部
 * 有能力探测降级，消费方 `?.()` 探测调用）；`openDetails` / `closeDetails`
 * 按 `ctx.layout` 是否有对应方法**能力探测**后提供（rc.2/alpha 均有，缺旧
 * 核心时降级为不提供该字段）。
 * @param ctx - 客户端根上下文。
 */
export function installPanelService(ctx: Context): void {
  const controller = createPanelConversationController()
  const api: PanelProtocol = {
    ActionItem: PanelActionItem,
    renderPanelContent: spec => controller.toggle(ctx, spec),
    closePanelContent: () => controller.close(),
    setPanelWidth: px => controller.width.setWidth(px),
    resetPanelWidth: () => controller.width.resetWidth(),
    getPanelWidth: () => controller.width.getWidth(),
  }
  if (typeof ctx.layout.openDetails === 'function')
    api.openDetails = () => ctx.layout.openDetails()
  if (typeof ctx.layout.closeDetails === 'function')
    api.closeDetails = () => ctx.layout.closeDetails()
  // Publish synchronously during apply: alpha slot injections can run before
  // sibling effects, so publishing from inside ctx.effect makes consumers see
  // an absent protocol and permanently skip their action registration.
  const disposeProtocol = ctx.reflect.provide(PANEL_PROTOCOL_SERVICE, api)
  ctx.effect(() => {
    return () => {
      controller.close()
      disposeProtocol()
    }
  }, 'dsh-tauri-panel: panel.protocol host service')
}
