import type { ILayout as UpstreamLayout } from '@deepseek-ai/dsh-client-ui-layout/client'

/**
 * 布局服务面（ctx.layout）。
 *
 * 上游类型随安装的核心版本变化，而仓库 devDependency 解析到的布局包仍是
 * 0.1.0-rc.8（只有 toggleSidebar / openDetails / closeDetails）。0.1.5-rc.1
 * 核心在运行时把 details 换成 rightbar，并新增全局面板选中 `selectPanel`。
 * 因此以上游类型为基座、可选地补上新核心方法，消费方一律能力探测后再调用。
 */
export interface ILayout extends UpstreamLayout {
  /**
   * ≥0.1.5-rc.1：按 `main` 槽的 key 选中全局面板，`null` 回到会话（不切换 Session）。
   * 传入未注册的 id 会上游抛错，调用前需自查 `main` 的 key 集合。
   */
  selectPanel?: (panelId: string | null) => void
  /** ≥0.1.5-rc.1：报告右侧栏是否占 track 以及是否全屏（取代 openDetails）。 */
  openRightbar?: (track: boolean, fullscreen: boolean) => void
  /** ≥0.1.5-rc.1：报告右侧栏隐藏（无 track、无手柄）。 */
  closeRightbar?: () => void
}

export interface LocaleService {
  register: (namespace: string, locale: string, dict: Record<string, unknown>) => () => void
  getLocale: () => { active: string }
  subscribe: (onChange: () => void) => () => void
}
