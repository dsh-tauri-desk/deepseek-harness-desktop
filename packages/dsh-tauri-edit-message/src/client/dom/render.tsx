/**
 * client/dom/render.tsx — 往命令式（原生 DOM）注入节点里渲染 React 子树。
 *
 * 注入的 Edit 按钮是 `document.createElement('button')` 造的原生节点，不属于 React 树，
 * 因此用 `createRoot` 在其内部挂载 `components/` 里的组件。
 * 返回值是卸载函数（卸载 React root 并移除容器），由注入节点回收时调用。
 */

import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * 把一个 React 元素渲染进给定的原生容器。
 *
 * @param container 目标容器（调用方负责插入宿主节点）。
 * @param element 要渲染的元素。
 * @returns 卸载函数：卸载 React root 并移除容器。
 */
export function renderInto(container: Element, element: ReactElement): () => void {
  const root = createRoot(container)
  root.render(element)
  return (): void => {
    root.unmount()
    container.remove()
  }
}
