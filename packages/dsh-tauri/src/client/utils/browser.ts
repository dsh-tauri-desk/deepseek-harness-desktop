/**
 * 点击稳定选择器命中的元素，返回是否真的点到了。
 *
 * DOM 退级路径（官方服务能力缺席 → 点官方按钮）需要「按钮是否存在」这个判定点，
 * 所以返回 boolean；非浏览器环境（无 `document`）按元素不存在处理。
 */
export function clickIfPresent(selector: string): boolean {
  if (typeof document === 'undefined')
    return false
  const element = document.querySelector<HTMLElement>(selector)
  if (element === null)
    return false
  element.click()
  return true
}

export function click(selector: string): void {
  clickIfPresent(selector)
}
