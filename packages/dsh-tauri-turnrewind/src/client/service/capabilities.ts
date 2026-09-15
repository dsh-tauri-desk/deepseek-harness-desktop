/**
 * client/service/capabilities.ts — 运行时能力探测（跨内核代，不做版本嗅探）。
 *
 * 本插件要用两个**只存在于新内核**的右侧边栏能力：控制器 `sidebarRight`
 * （`openFile` 预览 / `openTab` 打开页类型）与页类型注册表 `sidebarRightTabs`。
 *
 * 「打开文件」在两代内核上含义完全不同（旧内核的 `openFile` 会把路径交给宿主/系统打开），
 * 因此判据不是「有没有 openFile」；「审核」按钮则额外要求文件树页类型真的存在，否则
 * 点下去 `openTab('files')` 会抛 `no tab type is registered`。两处都用能力探测代替版本号
 * 嗅探——内核再漂移也只是退化成「能力缺席」。
 *
 * 探测在**渲染/点击那一刻**做（经注册 inject 工厂），而不是 apply 时：
 * 这些服务由另一个客户端插件发布，apply 顺序不保证它们已经就位。
 */

import type { ClientContext } from 'dsh-tauri/client'
import type { Capabilities, SidebarRightFace } from './capabilities.types'
import {
  TURNREWIND_SIDEBAR_FILES_KIND,
  TURNREWIND_SIDEBAR_RIGHT_SERVICE,
  TURNREWIND_SIDEBAR_RIGHT_TABS_SERVICE,
} from '../constants'

/** 探测当前内核的全部相关能力。 */
export function readCapabilities(ctx: ClientContext): Capabilities {
  const sidebar = readService(ctx, TURNREWIND_SIDEBAR_RIGHT_SERVICE)
  return {
    sidebar: sidebar === null || sidebar === undefined ? undefined : sidebar as SidebarRightFace,
    sidebarPreview: sidebar !== null && sidebar !== undefined,
    fileTree: hasTabType(readService(ctx, TURNREWIND_SIDEBAR_RIGHT_TABS_SERVICE), TURNREWIND_SIDEBAR_FILES_KIND),
  }
}

// --- internal ---

/**
 * 读反射注册表里的一个服务。
 *
 * 用 `reflect.get` 直接查注册表（不受 inject 守卫限制），因此本插件无需把它们写进
 * `inject`——声明式依赖会让旧内核上的插件加载直接失败。
 */
function readService(ctx: ClientContext, name: string): unknown {
  const reflect = ctx?.reflect
  if (reflect === undefined || typeof reflect.get !== 'function')
    return undefined
  try {
    return reflect.get(name)
  }
  catch {
    // 服务注册表在极端时序下可能抛错：按「没有该能力」处理，绝不因此报错。
    return undefined
  }
}

/** 注册表里是否真的有某个页类型；`this` 必须留在注册表实例上（get 读内部 kinds 表）。 */
function hasTabType(tabs: unknown, kind: string): boolean {
  if (tabs === null || tabs === undefined)
    return false
  const get = (tabs as { get?: unknown }).get
  if (typeof get !== 'function')
    return false
  try {
    return (get.call(tabs, kind)) !== undefined
  }
  catch {
    return false
  }
}
