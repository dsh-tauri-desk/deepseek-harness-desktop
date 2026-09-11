/**
 * client/utils/review.ts — 「审核」按钮的纯决策 + 受保护的调用。
 *
 * 需求：**新核心**点击「审核」打开侧边栏的文件树（会话工作区根目录），**旧核心不显示该按钮**。
 *
 * 决策规则：
 *
 *   1. 内核没有右侧边栏控制器（旧内核）→ 不渲染按钮；
 *   2. 控制器没有 `openTab`（契约漂移）→ 不渲染按钮；
 *   3. 注册表里没有「文件树」页类型 → 不渲染按钮。**这一条同样关键**：
 *      `openTab('files')` 在类型未注册时会抛 `sidebarRight: no tab type is registered as "files"`，
 *      渲染一个点下去必然失败的按钮就是「假交互」；
 *   4. 三条都满足才返回可用的点击处理器。
 *
 * 拆成纯函数是为了直接单测「旧内核绝不显示/绝不调用」这条不变量（不依赖 DOM 环境）。
 * 调用侧与「打开文件」同策：打开只是便利功能，失败静默（同步抛错 / rejected promise 都兜住），
 * 卡片没有错误展示面。
 */

import type { SidebarRightFace } from '../capabilities'

/** 决策输入。 */
export interface ReviewContext {
  /** 右侧边栏控制器最小面（缺席 = 旧内核）。 */
  sidebar: SidebarRightFace | undefined
  /** 注册表里是否已有「文件树」页类型（见 client/capabilities）。 */
  fileTree: boolean
  /** 要打开的页类型 kind（constants 里的 `TURNREWIND_SIDEBAR_FILES_KIND`）。 */
  kind: string
}

/**
 * 解析出可用的「审核」点击处理器；不可用时返回 `undefined`（调用方据此**不渲染按钮**）。
 * @param context - 右侧边栏控制器、文件树能力与目标 kind。
 * @returns 点击处理器，或 `undefined`。
 */
export function reviewOpenHandler(context: ReviewContext): (() => void) | undefined {
  const { sidebar, fileTree, kind } = context
  if (!fileTree || sidebar === undefined)
    return undefined
  const openTab = sidebar.openTab
  if (typeof openTab !== 'function')
    return undefined
  // 控制器的方法读 `this`（`require()` 取当前挂载的会话面、查 kinds 表），必须绑定后再调用。
  const open = openTab.bind(sidebar)
  return (): void => {
    try {
      void Promise.resolve(open(kind)).catch(() => undefined)
    }
    catch {
      /* 同步抛错（无挂载会话面 / 类型被注销）：同上，静默 */
    }
  }
}
