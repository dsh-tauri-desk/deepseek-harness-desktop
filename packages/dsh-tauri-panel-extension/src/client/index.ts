/**
 * client/index.ts — 扩展面板客户端装配入口。
 *
 * 只做 import + 组装（locale / styles / RPC / 注册）；无业务实现。
 * 结构分层见 AGENTS.md 客户端目录模板：types/ utils/ hooks/ config/ apis/
 * components/ register/ 各司其职。
 */

import type { ExtensionClientContext, Translate } from './types'
import { compat } from 'dsh-tauri/client'
import { createMcpInjected, createSkillsInjected } from './apis'
import { LOCALE_NAMESPACE, PLUGIN_ID } from './constants'
import { installExtensionLocale } from './locales'
import { installExtensionPanel } from './register/extension-panel'
import { registerSkillCreatorPrefill } from './register/skill-creator-prefill'
import { mountExtensionStyles } from './styles'

export const name = PLUGIN_ID
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

export function apply(ctx: ExtensionClientContext): void {
  const cx = compat(ctx)
  installExtensionLocale(ctx)
  ctx.effect(() => mountExtensionStyles(), `${PLUGIN_ID}: styles`)
  const t = ctx.locale.bind(LOCALE_NAMESPACE) as Translate
  registerSkillCreatorPrefill(ctx)
  installExtensionPanel(cx as ExtensionClientContext, t, createSkillsInjected(), createMcpInjected())
}
