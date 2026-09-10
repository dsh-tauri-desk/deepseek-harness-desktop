/**
 * client/utils/format.ts — 纯函数：计数文本、文件名、卡片状态判定、文件清单裁剪。
 *
 * 全部为纯函数，便于单测直接锁定（AGENTS.plugins.md「优先测试纯函数」）。
 * 计数文本供 `ChangeCounts` 的 `title` 使用：视觉是分开着色的两个 span，
 * 但读屏/悬浮提示要拿到同一条「+N -M」文本。
 */

import type { LocaleKey, SessionSummary, TurnCardState, TurnFileChange, TurnSummary } from '../types'
import {
  TURNREWIND_REASON_EXPIRED,
  TURNREWIND_REASON_GIT_REQUIRED,
  TURNREWIND_REASON_GIT_UNAVAILABLE,
  TURNREWIND_REASON_SNAPSHOT_FAILED,
  TURNREWIND_REASON_TURN_ACTIVE,
  TURNREWIND_REASON_UNSAFE_PATH,
} from '../../shared/constants'

/**
 * 线协议上的「不可用原因」码 → 文案键。
 *
 * 卡片必须给出人能读懂的原因，而不是把 `TURNREWIND_EXPIRED` 这样的码直接糊到界面上；
 * 但同时**不能丢掉未知码**（内核/宿主版本可能更新），未知码仍原样显示（见调用方）。
 */
const REASON_KEYS: Record<string, LocaleKey> = {
  [TURNREWIND_REASON_GIT_REQUIRED]: 'unavailableGitDesc',
  [TURNREWIND_REASON_GIT_UNAVAILABLE]: 'gitUnavailableReason',
  [TURNREWIND_REASON_EXPIRED]: 'expiredReason',
  [TURNREWIND_REASON_TURN_ACTIVE]: 'turnActiveReason',
  [TURNREWIND_REASON_SNAPSHOT_FAILED]: 'snapshotFailedReason',
  [TURNREWIND_REASON_UNSAFE_PATH]: 'unsafePathReason',
}

/**
 * 原因码对应的文案键；未知码或空值返回 null（调用方决定如何降级展示）。
 * @param reason - 宿主回传的原因码。
 * @returns 文案键或 null。
 */
export function reasonKey(reason: string | null | undefined): LocaleKey | null {
  if (reason === null || reason === undefined || reason.length === 0)
    return null
  return REASON_KEYS[reason] ?? null
}

/** 单行 `+N -M` 文本；二进制显示 binaryLabel。 */
export function formatCounts(file: Pick<TurnFileChange, 'insertions' | 'deletions' | 'binary'>, binaryLabel: string): string {
  if (file.binary)
    return binaryLabel
  const insertions = file.insertions ?? 0
  const deletions = file.deletions ?? 0
  return `+${insertions} -${deletions}`
}

/** 汇总的 `+N -M` 文本。 */
export function formatTotals(totals: { insertions: number, deletions: number }): string {
  return `+${totals.insertions} -${totals.deletions}`
}

/** 文件名（单文件卡片的标题用它）。 */
export function basename(path: string): string {
  const segments = path.split('/')
  return segments.at(-1) ?? path
}

/**
 * 卡片状态判定（纯函数）。
 * @param summary - 该会话的摘要；null 表示尚未取到。
 * @param turn - 本轮 turn 号。
 * @returns 卡片应呈现的状态（`hidden` 表示不占位）。
 */
export function resolveCardState(summary: SessionSummary | null, turn: number | undefined): TurnCardState {
  if (turn === undefined || !Number.isInteger(turn) || turn <= 0)
    return { kind: 'hidden' }
  if (summary === null)
    return { kind: 'hidden' }
  if (!summary.isGit) {
    // 非 Git：点撤销弹「需要 Git 仓库」说明；其它拒绝原因（家目录/盘根）只展示原因。
    return summary.unavailableReason !== null && summary.unavailableReason !== TURNREWIND_REASON_GIT_REQUIRED
      ? { kind: 'unavailable', reason: summary.unavailableReason }
      : { kind: 'git-required' }
  }
  const record = summary.turns.find(item => item.turn === turn)
  if (record === undefined)
    return { kind: 'hidden' }
  if (record.unavailable !== null && record.unavailable !== undefined) {
    /*
      「快照过程失败」是**通用内部失败**：没有文件明细、没有可操作指引。若这一轮连
      基线都没建立（hasBaseline === false），它从来没有过可撤销的承诺——用户中断、
      捕获子进程被回收、工作区 git 暂时报错都会落在这里，此时弹「撤销不可用」纯属惊扰
      （用户反馈：明明什么都没改，却看到一张写着内部错误码的告警卡片）。
      宿主侧仍然写日志，账本行也保留，诊断信息不丢；这里只是不打扰用户。

      其余原因一律照常呈现：超限类原因说明「这一轮超出撤销范围」，过期类说明
      「快照已被回收」——都是用户能理解、也可能需要采取行动的信息。
    */
    if (record.unavailable === TURNREWIND_REASON_SNAPSHOT_FAILED && record.hasBaseline === false)
      return { kind: 'hidden' }
    return { kind: 'failed', reason: record.unavailable }
  }
  if (record.files.length === 0)
    return { kind: 'hidden' }
  if (record.undoneAt !== null && record.undoneAt !== undefined)
    return { kind: 'undone', record }
  return { kind: 'ready', record }
}

/** 卡片标题：单文件用文件名，多文件用数量。 */
export function cardTitle(record: Pick<TurnSummary, 'files'>, one: (name: string) => string, many: (count: number) => string): string {
  if (record.files.length === 1)
    return one(basename(record.files[0]?.path ?? ''))
  return many(record.files.length)
}

/**
 * 文件清单的折叠窗口。
 *
 * `hiddenCount` 始终按**折叠态**计算：展开后按钮必须继续存在（否则用户无法收起），
 * 因此不能用「当前可见行数」反推被隐藏的数量。
 *
 * @param files - 本 turn 的全部变更文件。
 * @param expanded - 是否已展开。
 * @param limit - 折叠时显示的行数上限。
 * @returns 当前应渲染的行，以及折叠时会隐藏的行数。
 */
export function fileListWindow(
  files: readonly TurnFileChange[],
  expanded: boolean,
  limit: number,
): { visible: readonly TurnFileChange[], hiddenCount: number } {
  const collapsed = files.slice(0, limit)
  return {
    visible: expanded ? files : collapsed,
    hiddenCount: files.length - collapsed.length,
  }
}
