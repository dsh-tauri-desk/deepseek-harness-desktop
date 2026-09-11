import type { SessionSummary, TurnSummary } from '../types'
import { describe, expect, it } from 'vitest'
import {
  TURNREWIND_REASON_EXPIRED,
  TURNREWIND_REASON_GIT_UNAVAILABLE,
  TURNREWIND_REASON_SNAPSHOT_FAILED,
  TURNREWIND_REASON_TURN_ACTIVE,
  TURNREWIND_REASON_UNSAFE_PATH,
} from '../../shared/constants'
import { TURNREWIND_VISIBLE_FILE_ROWS } from '../constants'
import {
  basename,
  cardTitle,
  fileListWindow,
  formatCounts,
  formatTotals,
  hasTurnRecord,
  reasonKey,
  resolveCardState,
  summaryRetryDelayMs,
} from './format'

function turnSummary(patch: Partial<TurnSummary> = {}): TurnSummary {
  return {
    turn: 1,
    fileCount: 1,
    insertions: 4,
    deletions: 3,
    undoneAt: null,
    unavailable: null,
    truncated: false,
    files: [{ path: 'src/driver.ts', status: 'M', insertions: 4, deletions: 3, binary: false }],
    skippedOversized: [],
    skippedNestedRepos: [],
    ...patch,
  }
}

function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-1',
    isGit: true,
    workspaceRoot: 'C:/proj',
    unavailableReason: null,
    turns: [turnSummary()],
    ...patch,
  }
}

describe('formatCounts / formatTotals', () => {
  it('renders +N -M and falls back to the binary label', () => {
    expect(formatCounts({ insertions: 5, deletions: 3, binary: false }, 'binary')).toBe('+5 -3')
    expect(formatCounts({ insertions: null, deletions: null, binary: true }, 'binary')).toBe('binary')
    expect(formatCounts({ insertions: null, deletions: null, binary: false }, 'binary')).toBe('+0 -0')
  })

  it('renders totals', () => {
    expect(formatTotals({ insertions: 18, deletions: 10 })).toBe('+18 -10')
  })
})

describe('basename', () => {
  it('returns the last path segment as the file name', () => {
    expect(basename('skills/arch-upkeep/SKILL.md')).toBe('SKILL.md')
    expect(basename('a.txt')).toBe('a.txt')
  })
})

describe('resolveCardState', () => {
  it('stays hidden without a usable turn number or summary', () => {
    expect(resolveCardState(null, 1)).toEqual({ kind: 'hidden' })
    expect(resolveCardState(summary(), undefined)).toEqual({ kind: 'hidden' })
    expect(resolveCardState(summary(), 0)).toEqual({ kind: 'hidden' })
  })

  it('非 Git 仓库：整张卡片都不出现（GIT_REQUIRED / 无原因都保持沉默）', () => {
    // 用户实际报告：非 Git 工作区里每一轮结尾都弹「该工作区不是 Git 代码仓库」。
    expect(resolveCardState(summary({ isGit: false, unavailableReason: 'TURNREWIND_GIT_REQUIRED' }), 1)).toEqual({ kind: 'hidden' })
    expect(resolveCardState(summary({ isGit: false, unavailableReason: null }), 1)).toEqual({ kind: 'hidden' })
  })

  it('非 Git 但属于「可操作的诊断」时仍如实呈现（git 缺失 / 危险路径）', () => {
    expect(resolveCardState(summary({ isGit: false, unavailableReason: 'TURNREWIND_GIT_UNAVAILABLE' }), 1))
      .toEqual({ kind: 'unavailable', reason: 'TURNREWIND_GIT_UNAVAILABLE' })
    expect(resolveCardState(summary({ isGit: false, unavailableReason: 'TURNREWIND_UNSAFE_WORKSPACE' }), 1))
      .toEqual({ kind: 'unavailable', reason: 'TURNREWIND_UNSAFE_WORKSPACE' })
  })

  it('maps a recorded turn to ready / undone / failed / hidden', () => {
    expect(resolveCardState(summary(), 1)).toEqual({ kind: 'ready', record: turnSummary() })
    expect(resolveCardState(summary({ turns: [turnSummary({ undoneAt: 5 })] }), 1).kind).toBe('undone')
    expect(resolveCardState(summary({ turns: [turnSummary({ unavailable: 'TURNREWIND_TOO_MANY_FILES' })] }), 1))
      .toEqual({ kind: 'failed', reason: 'TURNREWIND_TOO_MANY_FILES' })
    // 记录存在但这一轮没有任何文件变化：不占位。
    expect(resolveCardState(summary({ turns: [turnSummary({ files: [] })] }), 1)).toEqual({ kind: 'hidden' })
    // 账本还没有这一轮的记录（after 快照仍在结算）：不占位，由组件做有限重试。
    expect(resolveCardState(summary(), 7)).toEqual({ kind: 'hidden' })
  })

  it('快照被回收（已过期）走失败态，交给文案映射成人话', () => {
    // 容量治理会把过期行的 files 清空：此时卡片仍要出现并说明原因，不能静默消失。
    const expired = turnSummary({ unavailable: TURNREWIND_REASON_EXPIRED, files: [], fileCount: 0 })
    expect(resolveCardState(summary({ turns: [expired] }), 1))
      .toEqual({ kind: 'failed', reason: TURNREWIND_REASON_EXPIRED })
  })

  it('连基线都没建立的通用快照失败不占位（用户中断 / 捕获被回收时不该弹告警）', () => {
    // 用户实际报告：什么都没改却看到「撤销不可用 TURNREWIND_SNAPSHOT_FAILED」。
    const noBaseline = turnSummary({
      unavailable: TURNREWIND_REASON_SNAPSHOT_FAILED,
      files: [],
      fileCount: 0,
      hasBaseline: false,
    })
    expect(resolveCardState(summary({ turns: [noBaseline] }), 1)).toEqual({ kind: 'hidden' })

    // 基线在、after 结算失败：承诺过的撤销落空了，必须如实告警。
    const withBaseline = turnSummary({
      unavailable: TURNREWIND_REASON_SNAPSHOT_FAILED,
      files: [],
      fileCount: 0,
      hasBaseline: true,
    })
    expect(resolveCardState(summary({ turns: [withBaseline] }), 1))
      .toEqual({ kind: 'failed', reason: TURNREWIND_REASON_SNAPSHOT_FAILED })

    // 旧宿主不带该字段：保守照常呈现（宁可多显示，也不要静默漏报）。
    const legacy = turnSummary({ unavailable: TURNREWIND_REASON_SNAPSHOT_FAILED, files: [], fileCount: 0 })
    expect(resolveCardState(summary({ turns: [legacy] }), 1).kind).toBe('failed')
  })

  it('超限类失败即使没有基线也照常呈现（说的是「超出撤销范围」，不是内部故障）', () => {
    const tooManyFiles = turnSummary({ unavailable: 'TURNREWIND_TOO_MANY_FILES', files: [], fileCount: 0, hasBaseline: false })
    expect(resolveCardState(summary({ turns: [tooManyFiles] }), 1))
      .toEqual({ kind: 'failed', reason: 'TURNREWIND_TOO_MANY_FILES' })
  })
})

describe('hasTurnRecord / summaryRetryDelayMs', () => {
  it('只看账本有没有这一轮的记录，不看卡片是否可见', () => {
    expect(hasTurnRecord(null, 1)).toBe(false)
    expect(hasTurnRecord(summary(), undefined)).toBe(false)
    expect(hasTurnRecord(summary(), 1)).toBe(true)
    expect(hasTurnRecord(summary(), 7)).toBe(false)
    // 空记录（该轮确实没有改动）也算「已落账」：重试窗口据此停止，不再白等。
    expect(hasTurnRecord(summary({ turns: [turnSummary({ files: [], fileCount: 0 })] }), 1)).toBe(true)
  })

  it('重试等待时间 700ms 起指数退避、5s 封顶', () => {
    expect(summaryRetryDelayMs(0, 700, 5000)).toBe(700)
    expect(summaryRetryDelayMs(1, 700, 5000)).toBe(1400)
    expect(summaryRetryDelayMs(2, 700, 5000)).toBe(2800)
    expect(summaryRetryDelayMs(3, 700, 5000)).toBe(5000)
    expect(summaryRetryDelayMs(11, 700, 5000)).toBe(5000)
    // 异常入参（负数/非整数/NaN）不能算出荒唐的等待时间。
    expect(summaryRetryDelayMs(-1, 700, 5000)).toBe(700)
    expect(summaryRetryDelayMs(Number.NaN, 700, 5000)).toBe(700)
    expect(summaryRetryDelayMs(1.9, 700, 5000)).toBe(1400)
  })
})

describe('reasonKey', () => {
  it('已知原因码映射到文案键', () => {
    expect(reasonKey(TURNREWIND_REASON_EXPIRED)).toBe('expiredReason')
    expect(reasonKey(TURNREWIND_REASON_GIT_UNAVAILABLE)).toBe('gitUnavailableReason')
    expect(reasonKey(TURNREWIND_REASON_TURN_ACTIVE)).toBe('turnActiveReason')
    expect(reasonKey(TURNREWIND_REASON_SNAPSHOT_FAILED)).toBe('snapshotFailedReason')
    expect(reasonKey(TURNREWIND_REASON_UNSAFE_PATH)).toBe('unsafePathReason')
  })

  it('未知码/空值返回 null：调用方原样显示，绝不编文案', () => {
    // 宿主可能先于客户端更新：未知码必须仍然可见，而不是显示空字符串。
    expect(reasonKey('TURNREWIND_FUTURE_REASON')).toBeNull()
    expect(reasonKey(null)).toBeNull()
    expect(reasonKey(undefined)).toBeNull()
    expect(reasonKey('')).toBeNull()
  })
})

describe('cardTitle', () => {
  it('names a single file and counts multiple files', () => {
    const one = (name: string) => `edited ${name}`
    const many = (count: number) => `edited ${count} files`
    expect(cardTitle({ files: turnSummary().files }, one, many)).toBe('edited driver.ts')
    expect(cardTitle({
      files: [
        { path: 'a.ts', status: 'M', insertions: 1, deletions: 0, binary: false },
        { path: 'b.ts', status: 'M', insertions: 1, deletions: 0, binary: false },
      ],
    }, one, many)).toBe('edited 2 files')
  })
})

describe('fileListWindow', () => {
  const files = Array.from({ length: 5 }, (_, index) => ({
    path: `f${index}.ts`,
    status: 'M' as const,
    insertions: 1,
    deletions: 0,
    binary: false,
  }))

  it('折叠时只显示三行，并给出被隐藏的数量', () => {
    expect(TURNREWIND_VISIBLE_FILE_ROWS).toBe(3)
    const collapsed = fileListWindow(files, false, TURNREWIND_VISIBLE_FILE_ROWS)
    expect(collapsed.visible).toHaveLength(3)
    expect(collapsed.hiddenCount).toBe(2)
  })

  it('展开后显示全部文件，但 hiddenCount 仍按折叠态计算（「收起文件」按钮必须还在）', () => {
    const expanded = fileListWindow(files, true, TURNREWIND_VISIBLE_FILE_ROWS)
    expect(expanded.visible).toHaveLength(5)
    expect(expanded.hiddenCount).toBe(2)
    // 收起后回到三行。
    expect(fileListWindow(files, false, TURNREWIND_VISIBLE_FILE_ROWS).visible).toHaveLength(3)
  })

  it('不超过三行时没有折叠控件', () => {
    const small = fileListWindow(files.slice(0, 3), false, TURNREWIND_VISIBLE_FILE_ROWS)
    expect(small.visible).toHaveLength(3)
    expect(small.hiddenCount).toBe(0)
  })
})
