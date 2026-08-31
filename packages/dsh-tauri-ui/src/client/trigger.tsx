import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type { SettingsTriggerProps } from './types'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
/**
 * trigger.tsx — sidebar.settings 座位的新“赢家”（priority -1）。
 *
 * 官方 SettingsRoot 以默认 priority 0 注册进 sidebar.settings 单槽；同 cell
 * 内最低 priority 渲染，因此本条目将其 shadow——官方“齿轮按钮 + 居中 modal”
 * 整体不再渲染。本组件取而代之：
 *   - 同款触发按钮（内容借 <SlotOutlet slotKey="settings.trigger"/> 复用官方的
 *     TriggerContent = 齿轮图标 + label，样式由本组件实现）；
 *   - 宿主 onboarding（谓词与官方一致：phase==='ready' 且无会话或当前会话
 *     blank），步骤经 <SlotOutlet slotKey="settings.onboarding"/> 渲染。
 *
 * 关键点：本条目**不声明任何 children**（声明的六列子槽归属于官方条目，
 * 再声明会 throw），所有“渲染他人声明的槽”都走 SlotOutlet —— 这也是
 * renderer 补丁（导出一行 SlotOutlet）存在的全部理由。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  SETTINGS_REGISTRANT,
  SETTINGS_SIDEBAR_SLOT,
  SETTINGS_TRIGGER_PRIORITY,
  SETTINGS_TRIGGER_SLOT,
} from './constants'

import { useSettingsOnboardingSteps } from './sections'
import { openSettings, useSettingsUi } from './store'

/**
 * 触发组件：侧栏脚部的齿轮按钮 + 空会话引导宿主。
 * @param props - 合成槽位 props。
 * @param props.wide - 侧栏展开态（折叠时渲染 rail 圆钮）。
 * @param props.useSessions - 框架标准钩子：会话列表快照（引导激活谓词）。
 * @returns 触发按钮（open 状态写入共享 store）与可能的引导步骤。
 */
export function SettingsTrigger({ wide, useSessions }: SettingsTriggerProps): ReactElement {
  const ui = useSettingsUi()
  const steps = useSettingsOnboardingSteps()
  const [completed, setCompleted] = useState<Set<string>>(() => new Set())

  // 官方同款引导谓词：就绪且（无当前会话 或 当前会话空日志）→ 引导激活。
  const onboardingActive = useSessions(
    state =>
      state.phase === 'ready'
      && (state.current === undefined || state.byId[state.current]?.blank === true),
  )

  // 引导退出时复位完成集（与官方一致）。
  useEffect(() => {
    if (!onboardingActive)
      setCompleted(new Set())
  }, [onboardingActive])

  const step = onboardingActive ? steps.find(s => !completed.has(s.id)) : undefined

  const completeStep = useCallback((id: string) => {
    setCompleted(previous => (previous.has(id) ? previous : new Set([...previous, id])))
  }, [])

  const openSection = useCallback((id: string) => {
    openSettings(id)
  }, [])

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={ui.open}
        onClick={() => openSettings()}
        className={`dsh-tu-settingsTrigger${wide ? '' : ' dsh-tu-settingsTriggerRail'}`}
      >
        <SlotOutlet slotKey={SETTINGS_TRIGGER_SLOT} ownerProps={{ wide }} />
      </button>
      {step !== undefined && (
        <SlotOutlet
          slotKey="settings.onboarding"
          ownerProps={{
            stepId: step.id,
            complete: () => completeStep(step.id),
            openSection,
          }}
          opts={{ only: step.id }}
        />
      )}
    </>
  )
}

/**
 * 注册：等待 sidebar.settings 声明后，以 priority -1 shadow 官方 SettingsRoot。
 *
 * 'sidebar.settings' 不属于本插件类型图的 SlotMap 键（声明权在 ui-sidebar，
 * 类型未提升到根 node_modules），此处对 options 显式 cast 以通过 K 收窄；
 * 组件 props 仍由本地 SettingsTriggerProps 提供类型保证。
 * @param ctx - 客户端根上下文。
 */
export function registerSettingsTrigger(ctx: Context): void {
  ctx.slots.inject(SETTINGS_SIDEBAR_SLOT as never, () =>
    ctx.slots.register(
      { name: SETTINGS_SIDEBAR_SLOT, priority: SETTINGS_TRIGGER_PRIORITY, registrant: SETTINGS_REGISTRANT } as never,
      SettingsTrigger,
    ))
}
