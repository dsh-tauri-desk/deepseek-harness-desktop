import type { SlotRegistry } from 'dsh-tauri/client'

/**
 * register/sections.ts — 'settings.section' / 'settings.onboarding' 投影的
 * 安装器半区：持有槽注册中心的模块引用（slotsRef），供 hooks/sections.ts
 * 的只读投影 hooks 在 render 期经 getSettingsSlots() 订阅。
 *
 * 引用所有权与卸载清理只存在本文件：installSettingsSections 在 apply 时把
 * ctx.slots 写入，返回的卸载函数在插件卸载后清除模块引用，避免跨实例残留。
 */

/** apply 时存入的槽注册中心（hooks/sections.ts 在 render 期经它订阅/投影）。 */
let slotsRef: SlotRegistry | undefined

/**
 * 在 apply 里安装：把 ctx.slots 引用留给投影 hooks，返回卸载清理。
 * @param slots - 客户端 slota 注册中心（ctx.slots）。
 * @returns 卸载函数（插件卸载后清除模块引用，避免跨实例残留）。
 */
export function installSettingsSections(slots: SlotRegistry): () => void {
  slotsRef = slots
  return () => {
    if (slotsRef === slots)
      slotsRef = undefined
  }
}

/** 读取当前槽注册中心（hooks/sections.ts 投影只读半区用）。 */
export function getSettingsSlots(): SlotRegistry | undefined {
  return slotsRef
}
