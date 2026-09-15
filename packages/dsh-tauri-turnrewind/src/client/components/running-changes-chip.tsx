import type { ReactElement } from 'react'
import type { RunningChangesChipProps } from './running-changes-chip.types'
/**
 * running-changes-chip.tsx — 会话运行中的实时变更提示条。
 *
 * 位置：`conversation.input.dock`（输入框上方独占一行）。宿主侧在 turn 进行期间定时刷新
 * 「当前工作区 vs before 快照」的读数，本组件只读那份缓存；turn 结束（宿主停表 + active=false）
 * 后提示条自行消失——收尾信息由 turn 尾部的变更卡片承担。
 */
import { useMountStyle } from 'dsh-tauri-ui/client'
import { TURNREWIND_CHIP_STYLE_ID, TURNREWIND_COUNTS_STYLE_ID } from '../constants'
import { useLiveChanges } from '../hooks/use-live-changes'
import { locale } from '../locales'
import countsStyle from '../styles/counts.cssr'
import { ChangeCounts } from './change-counts'
import chipStyle from './running-changes-chip.cssr'

export function RunningChangesChip(props: RunningChangesChipProps): ReactElement | null {
  useMountStyle(chipStyle, TURNREWIND_CHIP_STYLE_ID)
  useMountStyle(countsStyle, TURNREWIND_COUNTS_STYLE_ID)
  locale.useLocale()
  const sessionId = props.sessionId
  // owner 份额（InputZone.session）明确说「没在跑」时连轮询都不开；
  // 不同内核的会话快照字段可能不齐，缺失（undefined）时按「可能在跑」处理。
  const sessionRunning = props.session?.running
  const shouldPoll = sessionRunning !== false
  const live = useLiveChanges(sessionId, shouldPoll)

  // 会话一结束（owner 份额已翻成 false）立刻隐藏，不等下一次轮询返回，
  // 避免 turn 收尾卡片出现后提示条还残留一小段；宿主 live 读数同样要求 active。
  if (sessionRunning === false)
    return null
  if (live === null || !live.active || live.fileCount === 0)
    return null

  return (
    <div className="dshp-turnrewind-running">
      <div className="dshp-turnrewind-running__chip" data-turnrewind-running={String(live.turn ?? '')}>
        <span className="dshp-turnrewind-running__label">{locale.text('runningChanged', { count: live.fileCount })}</span>
        <ChangeCounts insertions={live.insertions} deletions={live.deletions} binary={false} binaryLabel={locale.text('binary')} />
      </div>
    </div>
  )
}
