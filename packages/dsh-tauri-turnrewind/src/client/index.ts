/**
 * dsh-tauri-turnrewind 客户端插件体（browser half）：turn 级变更卡片与一键撤销。
 *
 * 四项装配（全部经 ctx.effect，卸载即释放）：
 *   1. locale：注册 zh/en 字典并把语言切换桥接到 uSES rev；
 *   2. 能力：装入运行时能力探测所需的上下文（「打开文件」是否可用的判据）；
 *   3. 槽位 A：`conversation.chat.turnTail`（chain，priority -1）注册变更卡片 ——
 *      每轮结束处显示「已编辑 N 个文件 / +N -M / 文件清单 / 撤销」，
 *      并以同样的优先级替换官方 “Files changed” 行；
 *   4. 槽位 B：`conversation.input.dock`（list）注册运行中提示条 ——
 *      输入框上方实时显示「N 个文件已更改 +N -M」；读数在 turn 结束、新一轮开始、
 *      会话结束/切换时都会归零（宿主 resetLive + hooks 的订阅世代），不会跨轮累加；
 *   5. 样式：各组件 `useMountStyle` 自挂自卸，无需全局样式 effect。
 *
 * 依赖纪律（跨内核代硬约束，见 docs/plugins/11.优化计划.turnrewind实现.md §2.4-B）：
 * 本文件与整个 client/ 目录**不静态引用任何 `@deepseek-ai/*` 包**——client bundle
 * 在 dsh Web ModuleLoader 的 factory 里运行，模块表只认识内核当前装载的模块；
 * 引用了另一个内核代里不存在的 specifier 会让 loader 整棵树失败（界面白屏）。
 * 允许的 bare import 只有 react / dsh-tauri/client / dsh-tauri-ui/client。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { compat } from 'dsh-tauri/client'
import { registerCapabilities } from './capabilities'
import {
  TURNREWIND_EFFECT_CAPABILITIES,
  TURNREWIND_EFFECT_LOCALE,
  TURNREWIND_EFFECT_RUNNING_CHIP,
  TURNREWIND_EFFECT_TURN_TAIL,
  TURNREWIND_PLUGIN_NAME,
} from './constants'
import { registerLocale } from './locales'
import { registerRunningChangesChip } from './register/running-chip'
import { registerTurnChangesCard } from './register/turn-tail'

export type {
  LiveSnapshot,
  LocaleKey,
  RunningChangesChipProps,
  SessionSummary,
  TurnCardState,
  TurnChangesCardProps,
  TurnFileChange,
  TurnrewindSessionState,
  TurnrewindUiState,
  TurnSummary,
  UndoResponse,
} from './types'

/** 插件显示名（诊断元数据）。 */
export const name = TURNREWIND_PLUGIN_NAME

/** 需要的客户端服务：slots（槽位注册）、locale（双语文案）。 */
export const inject = ['slots', 'locale']

/**
 * 插件体：安装文案、能力探测、变更卡片与运行中提示条。
 *
 * 「打开文件」按内核能力分流（新核心 → 侧边栏预览；旧核心 → 静默），
 * 能力探测所需的上下文由 {@link registerCapabilities} 装好（见 client/capabilities）。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const cx = compat(ctx)
  ctx.effect(() => registerCapabilities(cx), TURNREWIND_EFFECT_CAPABILITIES)
  ctx.effect(() => registerLocale(cx), TURNREWIND_EFFECT_LOCALE)
  ctx.effect(() => registerTurnChangesCard(cx), TURNREWIND_EFFECT_TURN_TAIL)
  ctx.effect(() => registerRunningChangesChip(cx), TURNREWIND_EFFECT_RUNNING_CHIP)
}
