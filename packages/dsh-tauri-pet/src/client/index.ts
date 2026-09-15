import type { ClientContext } from 'dsh-tauri/client'
import { PET_PLUGIN_NAME } from '../shared/constants'
import {
  PET_ICON_PATCH_EFFECT,
  PET_LOCALE_EFFECT,
  PET_PREFILL_EFFECT,
  PET_SECTION_EFFECT,
  PET_STYLES_EFFECT,
} from './constants'
import { locale } from './locales'
import { petSectionFeature } from './register/pet-section'
import { prefillFeature } from './register/prefill'
import { sidebarIconFeature } from './register/sidebar-icon'
import { stylesFeature } from './register/styles'

/** 插件显示名（诊断元数据）。 */
export const name = PET_PLUGIN_NAME

/** 需要的客户端服务：slots（槽位注册）、locale（双语文案）、sessions/workspaces（新建会话）。 */
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

/** 插件体：安装文案与样式，注册设置分区、侧栏入口补丁与草稿注入。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, PET_LOCALE_EFFECT)
  ctx.effect(stylesFeature, PET_STYLES_EFFECT)
  ctx.effect(petSectionFeature, PET_SECTION_EFFECT)
  ctx.effect(sidebarIconFeature, PET_ICON_PATCH_EFFECT)
  ctx.effect(prefillFeature, PET_PREFILL_EFFECT)
}
