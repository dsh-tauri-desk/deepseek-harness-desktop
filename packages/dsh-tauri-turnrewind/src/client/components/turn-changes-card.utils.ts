import type { SidebarRightFace } from '../service/capabilities.types'
import type { FileOpener } from './turn-changes-card.types'

/**
 * 卡片上的两处「便利但必须按内核能力分流」的点击决策（纯函数 + 受保护的调用）。
 *
 * 决策规则：
 *   1. 打开文件：框架没有派发 `openFile`，或当前内核没有应用内右侧边栏能力 → 返回 undefined。
 *      **后者是关键**：旧内核也派发 `openFile`，但它会把路径交给宿主/系统打开；
 *      能力缺席时调用方渲染成不可点的普通元素（不给「点了没反应」的假交互）。
 *   2. 审核：控制器缺席（旧内核）、控制器没有 `openTab`、或注册表里没有「文件树」页类型
 *      → 返回 undefined（调用方据此**不渲染按钮**）。第三条同样关键：`openTab('files')`
 *      在类型未注册时会抛 `sidebarRight: no tab type is registered as "files"`。
 *
 * 拆成纯函数是为了直接单测「旧内核绝不打开 / 绝不显示」这条不变量（不依赖 DOM 环境）。
 * 打开只是便利功能：同步抛错与 rejected promise 一律静默（卡片没有错误展示面）。
 */

/** 解析出可用的「打开文件」点击处理器；不可用时返回 undefined。 */
export function fileOpenHandler(input: {
  openFile?: FileOpener | undefined
  sidebarPreview: boolean
}): ((path: string) => void) | undefined {
  const { openFile, sidebarPreview } = input
  if (!sidebarPreview || typeof openFile !== 'function')
    return undefined
  const open = openFile
  return (path: string): void => {
    try {
      void Promise.resolve(open(path)).catch(() => undefined)
    }
    catch {
      /* 同步抛错：同上，静默 */
    }
  }
}

/** 解析出可用的「审核」点击处理器；不可用时返回 undefined。 */
export function reviewOpenHandler(input: {
  sidebar: SidebarRightFace | undefined
  fileTree: boolean
  kind: string
}): (() => void) | undefined {
  const { sidebar, fileTree, kind } = input
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
