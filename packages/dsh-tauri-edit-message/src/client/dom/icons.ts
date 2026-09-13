/**
 * client/dom/icons.ts — 命令式图标（DOM 注入用）。
 *
 * 注入节点是原生 DOM，不能渲染 React 组件；这里按 Gravity UI 上游的
 * `viewBox="0 0 16 16"` + `fill="currentColor"` 形状用 createElementNS 造同款 SVG，
 * 颜色完全交给 CSS（currentColor + 主题变量），亮色 / 暗色主题自动适配。
 *
 * 形状来源：`@gravity-ui/icons` 的 Pencil（MIT）。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Gravity UI Pencil。 */
const PENCIL_PATH = 'M11.423 1A3.577 3.577 0 0 1 15 4.577c0 .27-.108.53-.3.722l-.528.529-1.971 1.971-5.059 5.059a3 3 0 0 1-1.533.82l-2.638.528a1 1 0 0 1-1.177-1.177l.528-2.638a3 3 0 0 1 .82-1.533l5.059-5.059 2.5-2.5c.191-.191.451-.299.722-.299m-2.31 4.009-4.91 4.91a1.5 1.5 0 0 0-.41.766l-.38 1.903 1.902-.38a1.5 1.5 0 0 0 .767-.41l4.91-4.91a2.08 2.08 0 0 0-1.88-1.88m3.098.658a3.6 3.6 0 0 0-1.878-1.879l1.28-1.28c.995.09 1.788.884 1.878 1.88z'

/** 造一个 16×16、`fill="currentColor"` 的图标 SVG。 */
export function createPencilIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('fill', 'currentColor')
  path.setAttribute('fill-rule', 'evenodd')
  path.setAttribute('clip-rule', 'evenodd')
  path.setAttribute('d', PENCIL_PATH)
  svg.appendChild(path)
  return svg
}
