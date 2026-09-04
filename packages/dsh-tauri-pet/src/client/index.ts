/**
 * client/index.ts — dsh-tauri-pet 客户端插件体（browser half）：侧栏入口 + 设置分区。
 *
 * 能力（零结构改壳、零新增运行时依赖）：
 *   - 侧栏入口：DOM 补丁把一个官方 `.rtSEdW_iconButton` 样式的切换按钮插到
 *     dsh-tauri-ui 设置触发器（`.dsh-tu-settingsTrigger`）右侧、同一容器内
 *     （`.sidebar.settings` 的子元素）。按钮只有激活/未激活两态（激活时右上角
 *     绿色小圆点），点击即切换桌宠启用状态，不弹面板。
 *   - 设置分区：注册进 `settings.section` 槽（与归档分区同点位），提供启用
 *     开关、宠物大小拖动条、选择宠物、显示/隐藏；全部经 dsh-tauri invoke 桥
 *     调用桌面端 Tauri 命令
 *     （get_pet_status/set_pet_enabled/set_active_pet/set_pet_size/show_pet/hide_pet）。
 *
 * 依赖：slots（注册 settings.section）、locale（双语文案）。invoke 桥来自
 * dsh-tauri/client。
 */
import type { ClientContext } from 'dsh-tauri/client'
import { PET_CLIENT_PLUGIN, PET_STYLES_EFFECT } from './constants'
import { installLocale } from './locales'
import { installPetIconPatch, registerPetPrefill, registerPetSection } from './register/pet'
import { installPetSessionForwarder } from './service/activity'
import { mountPetStyles } from './styles'

/** 插件显示名（诊断元数据）。 */
export const name = PET_CLIENT_PLUGIN

/** 需要的客户端服务：slots（注册 settings.section）、locale（双语文案）。 */
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

/**
 * 插件体：安装文案、样式，注册宠物设置分区并安装侧栏入口补丁。
 * @param ctx - 客户端根上下文（须已注入 slots/locale）。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => mountPetStyles(), PET_STYLES_EFFECT)

  installLocale(ctx)

  registerPetSection(ctx)
  installPetIconPatch(ctx)
  registerPetPrefill(ctx)
  installPetSessionForwarder(ctx)
}
