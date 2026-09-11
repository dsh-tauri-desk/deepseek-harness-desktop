/**
 * client/capabilities/index.ts — 运行时能力探测（跨内核代，不做版本嗅探）。
 *
 * 本插件要用两个**只存在于新内核**的右侧边栏能力：
 *
 * | 能力 | 发布方 | 用途 |
 * |---|---|---|
 * | `sidebarRight` 控制器 | `dsh-client-ui-sidebar-right` | `openResource`（打开文件预览）/ `openTab`（打开页类型） |
 * | `sidebarRightTabs` 注册表 | 同一个 effect 里发布 | `get(kind)` 判断某个页类型（如文件树 `files`）是否真的注册了 |
 *
 * 「打开文件」在两代内核上含义**完全不同**（旧内核的 `openFile` 会把路径交给宿主/系统打开），
 * 因此判据不是「有没有 `openFile`」；「审核」按钮则额外要求**文件树页类型真的存在**，
 * 否则点下去 `openTab('files')` 会抛 `no tab type is registered`。两处都用能力探测，
 * 代替版本号嗅探——内核再漂移也只是退化成「能力缺席」。
 *
 * 探测在**渲染/点击那一刻**做（而不是 apply 时）：这些服务由另一个客户端插件发布，
 * apply 顺序不保证它们已经就位。
 */

import type { ClientContext } from 'dsh-tauri/client'
import {
  TURNREWIND_SIDEBAR_FILES_KIND,
  TURNREWIND_SIDEBAR_RIGHT_SERVICE,
  TURNREWIND_SIDEBAR_RIGHT_TABS_SERVICE,
} from '../constants'

/**
 * 右侧边栏控制器里本插件会用到的最小面（只声明真正调用的方法，不复制宿主契约）。
 */
export interface SidebarRightFace {
  /** 打开一个页类型（新内核 `ctx.sidebarRight.openTab`）。 */
  openTab?: (kind: string) => unknown
}

/** 已安装的上下文（apply 时注入；未安装 = 尚无能力信息，按「没有」处理）。 */
let context: ClientContext | undefined

/**
 * 安装能力探测所需的上下文。
 * @param ctx - 客户端根上下文。
 * @returns 卸载时清除引用的 disposer（避免插件卸载后残留旧上下文）。
 */
export function registerCapabilities(ctx: ClientContext): () => void {
  context = ctx
  return () => {
    if (context === ctx)
      context = undefined
  }
}

/**
 * 读反射注册表里的一个服务。
 *
 * 用 `reflect.get` 直接查注册表（不受 inject 守卫限制），因此本插件无需把它们写进
 * `inject`——声明式依赖会让旧内核上的插件加载直接失败。
 * @param name - 服务名。
 * @returns 服务实例；缺席、形状不符或注册表抛错都返回 undefined。
 */
function readService(name: string): unknown {
  const reflect = context?.reflect
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

/**
 * 读取右侧边栏控制器。
 * @returns 控制器最小面；旧内核（没有该服务）返回 undefined。
 */
export function readSidebarRight(): SidebarRightFace | undefined {
  const face = readService(TURNREWIND_SIDEBAR_RIGHT_SERVICE)
  return face === null || face === undefined ? undefined : face as SidebarRightFace
}

/**
 * 当前内核是否具备「应用内右侧边栏预览」能力（「打开文件」的判据）。
 * @returns 有 `sidebarRight` 服务时为 true。
 */
export function hasSidebarPreview(): boolean {
  return readSidebarRight() !== undefined
}

/**
 * 右侧边栏是否注册了「文件树」页类型（「审核」按钮的判据）。
 *
 * 旧内核连 `sidebarRightTabs` 服务都没有 → false → 按钮不渲染。
 * @returns 注册表里 `get('files')` 有定义时为 true。
 */
export function hasSidebarFileTree(): boolean {
  const tabs = readService(TURNREWIND_SIDEBAR_RIGHT_TABS_SERVICE)
  if (tabs === null || tabs === undefined)
    return false
  const get = (tabs as { get?: unknown }).get
  if (typeof get !== 'function')
    return false
  try {
    // `this` 必须留在注册表实例上（get 读内部 kinds 表）。
    return (get.call(tabs, TURNREWIND_SIDEBAR_FILES_KIND)) !== undefined
  }
  catch {
    return false
  }
}
