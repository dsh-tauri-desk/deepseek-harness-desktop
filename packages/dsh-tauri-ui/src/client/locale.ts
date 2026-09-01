/**
 * locale.ts — 本插件自有的界面文案（返回应用 / 搜索设置… / 设置）。
 *
 * 用 locale 服务的**非类型化**注册面（register(ns, locale, dict)）挂进
 * dsh 的 locale 表：zh/en 双语齐全即满足运行时“bilingual balance”约束，
 * 且无需增广 LocaleNamespaceMap（避免外部类型依赖）。
 *
 * 组件侧不引入框架的 `t` 座（那需要 register option locale + 增广），
 * 改用一个极薄的 uSES 桥：apply 时订阅 locale 变更并推进 rev ->
 * 组件订阅 rev 重渲染，文案按当前 active locale 从本地字典读取。
 */
import type { ClientContext } from 'dsh-tauri/client'
import type { SettingsUiKey } from './types'
import { createExternalStore } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { DICT_EN, DICT_ZH, SETTINGS_UI_NS } from './constants'

export type { SettingsUiKey } from './types'

/** 活跃语言 id（module 级缓存，apply 时初始化并由订阅推进）。 */
let activeLocale = 'en'

/** locale 变更推进器：revision 前进 -> uSES 订阅方重渲染。 */
export const settingsLocaleRev = createExternalStore({ rev: 0 })

/**
 * 在 apply 里安装：注册本插件的双语字典，并桥接 locale 变更到 rev。
 * @param ctx - 客户端根上下文（须已注入 locale 服务）。
 */
export function installSettingsLocale(ctx: ClientContext): void {
  activeLocale = ctx.locale.getLocale().active
  ctx.locale.register(SETTINGS_UI_NS, 'zh', DICT_ZH)
  ctx.locale.register(SETTINGS_UI_NS, 'en', DICT_EN)
  ctx.locale.subscribe(() => {
    activeLocale = ctx.locale.getLocale().active
    settingsLocaleRev.set(s => ({ ...s, rev: s.rev + 1 }))
  })
}

/** 按当前活跃语言取一条文案。 */
export function settingsText(key: SettingsUiKey): string {
  return activeLocale === 'zh' ? DICT_ZH[key] : DICT_EN[key]
}

/** 组件内订阅 locale 变更（revision 前进即重渲染）。 */
export function useSettingsLocale(): void {
  useSyncExternalStore(settingsLocaleRev.subscribe, () => settingsLocaleRev.getSnapshot().rev)
}
