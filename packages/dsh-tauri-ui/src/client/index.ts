/**
 * dsh-tauri-ui 客户端插件体（browser half）：定制化 Tauri UI 的未来载体。
 *
 * 第一项功能：把 dsh 的设置弹窗（dialog）改为左侧停靠的侧边栏
 * （左栏 = 返回应用 + 搜索 + 设置项导航；右侧 = 官方各设置分区内容）。
 *
 * 关系：`dsh-tauri` 是纯消息桥（无 UI、无运行时依赖），只负责把宿主导航栏
 * 命令转发给 iframe 内的 dsh 应用并回报状态；本插件是它的 **UI 半区**——
 * 桌面风格的自定义 chrome 作为插件加载进 `shell.overlay` 帧级浮动层。
 *
 * 本功能的结构（全部 slot-shadow，零结构补丁，零新增依赖）：
 *   - trigger.tsx   注册进 sidebar.settings（priority -1）shadow
 *     官方 SettingsRoot：齿轮按钮 + onboarding 宿主；官方 dialog 被抑制。
 *   - sidebar.tsx   注册进 shell.overlay（id dsh-tauri-ui-settings）：
 *     整窗 docked 左栏 + 内容区，经 <SlotOutlet slotKey="settings.section"/>
 *     渲染官方各分区（SlotOutlet 由 renderer 的一行导出补丁提供）。
 *   - store.ts      触发器与侧边栏共享 {open, activeId, query}。
 *   - sections.ts   'settings.section' / 'settings.onboarding'
 *     注册条目的导航行投影（订阅槽位与 locale 变更）。
 *   - locale.ts     本插件文案（返回应用/搜索设置…）双语注册。
 *
 * 保留了骨架期的 `shell.overlay` 条目（id dsh-tauri-ui）作为未来 chrome
 * 的落点，与设置侧边栏（id dsh-tauri-ui-settings）并行不冲突。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
import {
  SETTINGS_REGISTRANT,
  SETTINGS_SHELL_OVERLAY_SLOT,
  SETTINGS_SHELL_SEAT_ID,
  SETTINGS_UI_PLUGIN,
} from './constants'
import { installSettingsLocale } from './locale'
import { TauriUiSeat } from './seat'
import { installSettingsSections } from './sections'
import { registerSettingsSidebar } from './sidebar'
import { mountSettingsStyles } from './styles'
import { registerSettingsTrigger } from './trigger'

/** 插件显示名（诊断元数据）。 */
export const name = SETTINGS_UI_PLUGIN

/** 需要的客户端服务：slots（注册点位）、layout（未来 chrome 的面板动作）、locale（双语文案）。 */
export const inject = ['slots', 'layout', 'locale']

/**
 * 插件体：注册未来 chrome 的落点座位 + 设置侧边栏功能。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  // 骨架期落点：未来桌面 chrome（顶部导航/窗口控件等）在此渲染。
  // alpha 的 slot 必须先由父条目的 children 表声明才能注册进入；shell.overlay
  // 由 ui-layout 的 AppFrame 声明，故通过 inject 等其声明（live）后再注册，
  // 避免 `slot "shell.overlay" is not declared` 运行时报错。
  ctx.effect(
    () =>
      ctx.slots.inject(SETTINGS_SHELL_OVERLAY_SLOT, () =>
        ctx.slots.register(
          {
            name: SETTINGS_SHELL_OVERLAY_SLOT,
            id: SETTINGS_SHELL_SEAT_ID,
            registrant: SETTINGS_REGISTRANT,
          },
          TauriUiSeat,
        )),
    'dsh-tauri-ui: shell.overlay seat',
  )

  // 第一项功能：设置弹窗 → 侧边栏。
  // 侧边栏依赖 renderer 补丁导出的 <SlotOutlet>（任意槽渲染的入口）。核心未带
  // 补丁时（旧安装），SlotOutlet 为 undefined —— 此时降级：不注册侧边栏与
  // 触发条目，官方设置 dialog 原样工作，绝不白屏（功能整体不生效即可）。
  ctx.effect(
    () => mountSettingsStyles(),
    'dsh-tauri-ui: settings styles',
  )
  installSettingsLocale(ctx)
  installSettingsSections(ctx.slots)
  if (typeof SlotOutlet === 'function') {
    registerSettingsSidebar(ctx)
    registerSettingsTrigger(ctx)
  }
  else {
    console.warn(
      '[dsh-tauri-ui] <SlotOutlet> unavailable (renderer patch missing) — settings sidebar disabled, official dialog stays.',
    )
  }
}
