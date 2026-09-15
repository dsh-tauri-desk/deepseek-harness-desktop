/**
 * client/index.ts — dsh-tauri-turnrewind 客户端插件体（browser half）。
 *
 * 依赖纪律（跨内核代硬约束，见 docs/plugins/11.优化计划.turnrewind实现.md §2.4-B）：
 * 本文件与整个 client/ 目录**不静态引用任何 `@deepseek-ai/*` 包**——client bundle 在 dsh Web
 * ModuleLoader 的 factory 里运行，模块表只认识内核当前装载的模块；引用了另一个内核代里不存在
 * 的 specifier 会让 loader 整棵树失败（界面白屏）。
 * 允许的 bare import 只有 react / dsh-tauri/client / dsh-tauri-ui/client。
 */

import type { ClientContext } from 'dsh-tauri/client'
import {
  TURNREWIND_LOCALE_EFFECT,
  TURNREWIND_PLUGIN_NAME,
  TURNREWIND_RUNNING_CHIP_EFFECT,
  TURNREWIND_SUMMARY_EFFECT,
  TURNREWIND_TURN_TAIL_EFFECT,
} from './constants'
import { locale } from './locales'
import { runningChipFeature } from './register/running-chip'
import { summaryFeature } from './register/summary'
import { turnTailFeature } from './register/turn-tail'

export type * from './types'

/** 插件显示名（诊断元数据）。 */
export const name = TURNREWIND_PLUGIN_NAME

/** 需要的客户端服务：slots（槽位注册）、locale（双语文案）。 */
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, TURNREWIND_LOCALE_EFFECT)
  ctx.effect(summaryFeature, TURNREWIND_SUMMARY_EFFECT)
  ctx.effect(turnTailFeature, TURNREWIND_TURN_TAIL_EFFECT)
  ctx.effect(runningChipFeature, TURNREWIND_RUNNING_CHIP_EFFECT)
}
