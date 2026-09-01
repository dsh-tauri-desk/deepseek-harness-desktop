import type { ReactElement } from 'react'
import {
  IconAgentPresetOutline16,
  IconDataOutline16,
  IconPersonalizationOutline16,
  IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * nav-icon.tsx — 设置导航行的分区图标。
 *
 * `settings.section` 契约只携带 {id, order, label}；官方 SettingsRoot 在壳内
 * 按 id 从闭集选图标（models / agent-presets / plugins，未知 id 回落设置齿轮）。
 * 本侧边栏镜像同一映射、复用同一图标组件（@deepseek-ai/dsh-client-ui-primitives
 * 经 ModuleLoader 解析，与官方视觉同源、自动跟随上游），保证停靠设置栏与官方
 * 设置弹窗的导航观感一致。
 */

/** 官方 navIcon 同款闭集映射：已知分区 id → 图标组件。 */
const NAV_ICONS: Record<string, typeof IconSettingsOutline16> = {
  'models': IconDataOutline16,
  'agent-presets': IconAgentPresetOutline16,
  'plugins': IconPersonalizationOutline16,
}

/** 渲染分区导航图标（官方兜底语义：未知 id 显示设置齿轮）。 */
export function SettingsNavIcon({ id }: { id: string }): ReactElement {
  const Icon = NAV_ICONS[id] ?? IconSettingsOutline16
  return <Icon size={16} className="dsh-tu-settingsNavIcon" />
}
