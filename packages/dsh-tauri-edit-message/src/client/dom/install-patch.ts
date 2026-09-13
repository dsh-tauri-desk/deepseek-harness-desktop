/**
 * client/dom/install-patch.ts — 安装气泡 DOM 注入（样式 + 观察器）并返回 disposer。
 *
 * 样式从 `styles/editor.cssr.ts` 的 CNode 挂载（`mountStyle` 幂等、引用计数）；
 * observer / timeout 全部登记进 `createLifecycleController`，卸载时一次性释放。
 * 官方 React 每次重绘都会重建操作行，注入的按钮随之消失，因此观察器必须在变更时
 * 补回；注入节点带 `data-mtx-injected`，遍历跳过它们，不会自激。
 */

import { mountStyle } from 'dsh-tauri-ui/client'
import { createLifecycleController } from 'dsh-tauri/client'
import { EDITOR_STYLE_ID } from '../constants'
import editorStyle from '../styles/editor.cssr'
import { patchSubtree } from './message-patch'

/** 安装样式、观察器与两次首屏补齐；返回释放函数。 */
export function installMessagePatch(): () => void {
  const controller = createLifecycleController()
  controller.add(mountStyle(editorStyle, EDITOR_STYLE_ID))

  const once = (): void => {
    patchSubtree(document.documentElement)
  }

  // 全文档观察：会话切换、懒加载、流式追加都会把新行挂进来。
  controller.observe(document.documentElement, { childList: true, subtree: true }, once)
  // 首屏立即补齐一次（React 可能已渲染完成），再补一次覆盖迟到的行。
  controller.timeout(once, 0)
  controller.timeout(once, 240)

  return () => {
    controller.dispose()
  }
}
