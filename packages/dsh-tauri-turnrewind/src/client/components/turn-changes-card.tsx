import type { ReactElement } from 'react'
import type { TurnChangesCardProps, TurnFileChange } from '../types'
import { ArrowUturnCcwLeft, ChevronDown, ChevronUp, Icon, SquarePlus, useMountStyle } from 'dsh-tauri-ui/client'
/**
 * turn-changes-card.tsx — 一轮结束时渲染的变更卡片（视觉对齐官方 deliverables 行）。
 *
 * 职责拆分：槽位注册在 register/turn-tail.ts，数据在 store/，样式在 .cssr.ts，
 * 纯函数判定与格式化在 utils/format.ts（本文件只做组合与交互）。
 *
 * 交互边界（需求明确）：
 *   - **真功能**：「撤销」、「再显示 N 个文件 / 收起文件」、**点击文件打开**；
 *   - **占位**：`📝 文件`（图标块）无点击处理（`data-placeholder` 标注）；
 *     「审核」整体隐藏（`TODO(review-action)`）；
 *     hover 的「查看更改」整体停用（`TODO(view-changes-hover)`，本次开放打开功能**未**附带 hover 视觉）。
 *
 * 「点击文件打开」按内核能力分流：新核心经 owner props 的 `openFile` 在应用内右侧边栏
 * 打开预览页签；旧核心虽然也派发 `openFile`（会交给宿主/系统打开），但需求要求那里
 * **静默**，因此只在探测到右侧边栏能力时才把标题 / 清单行渲染成可点元素
 * （见 client/capabilities/index.ts 与 client/utils/open-file.ts）。
 *
 * 单文件与多文件的差异：单文件时标题就是文件名、不渲染清单，
 * hover 时副行的计数换成「查看更改 ↗」（当前停用）；多文件时标题是文件数、
 * 副行固定显示总计数，清单最多三行。
 */
import { useEffect, useState } from 'react'
import { hasSidebarPreview } from '../capabilities'
import {
  TURNREWIND_CARD_STYLE_ID,
  TURNREWIND_COUNTS_STYLE_ID,
  TURNREWIND_SUMMARY_MAX_RETRIES,
  TURNREWIND_SUMMARY_RETRY_DELAY_MS,
  TURNREWIND_SUMMARY_RETRY_MAX_DELAY_MS,
  TURNREWIND_VISIBLE_FILE_ROWS,
} from '../constants'
import { text, useLocale } from '../locales'
import { ensureSummary, requestUndo, retrySummaryForTurn, useTurnrewindSession } from '../store'
import countsStyle from '../styles/counts.cssr'
import { cardTitle, fileListWindow, formatCounts, formatTotals, hasTurnRecord, reasonKey, resolveCardState, summaryRetryDelayMs } from '../utils/format'
import { fileOpenHandler } from '../utils/open-file'
import { ChangeCounts } from './change-counts'
import { GitRequiredDialog } from './git-required-dialog'
import cardStyle from './turn-changes-card.cssr'

export function TurnChangesCard(props: TurnChangesCardProps): ReactElement | null {
  useMountStyle(cardStyle, TURNREWIND_CARD_STYLE_ID)
  useMountStyle(countsStyle, TURNREWIND_COUNTS_STYLE_ID)
  useLocale()
  const sessionId = props.sessionId
  const turn = props.matched?.turn ?? props.turn?.turn
  const state = useTurnrewindSession(sessionId)
  // 展开态按 turn 记账，而不是「effect 里复位布尔量」：卡片会被复用渲染下一轮，
  // 用 turn 作为天然的复位键（也避开 set-state-in-effect 的多余渲染）。
  const [expandedTurn, setExpandedTurn] = useState<number | undefined>(undefined)
  const expanded = expandedTurn !== undefined && expandedTurn === turn
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    void ensureSummary(sessionId)
  }, [sessionId])

  const card = resolveCardState(state.summary, turn)
  const attempts = turn === undefined ? 0 : (state.attempts[turn] ?? 0)
  // after 快照在 turn/end 之后**后台结算**（还要排在同一条队列的实时读数之后），大仓库上
  // 可能十几秒才落账。这里等的判据是「账本还没有这一轮」，而不是「卡片不可见」——
  // 该轮确实没有改动时账本会写一条空记录，那种情况不该继续重试。
  const waiting = card.kind === 'hidden'
    && state.status === 'ready'
    && state.summary !== null
    && state.summary.isGit
    && sessionId !== undefined
    && turn !== undefined
    && !hasTurnRecord(state.summary, turn)
    && attempts < TURNREWIND_SUMMARY_MAX_RETRIES

  useEffect(() => {
    if (!waiting || sessionId === undefined || turn === undefined)
      return
    const timer = setTimeout(
      () => {
        void retrySummaryForTurn(sessionId, turn)
      },
      summaryRetryDelayMs(attempts, TURNREWIND_SUMMARY_RETRY_DELAY_MS, TURNREWIND_SUMMARY_RETRY_MAX_DELAY_MS),
    )
    return () => clearTimeout(timer)
  }, [waiting, sessionId, turn, attempts])

  if (card.kind === 'hidden')
    return null

  const record = card.kind === 'ready' || card.kind === 'undone' ? card.record : null
  const files = record?.files ?? []
  // 单文件：标题即文件名、不渲染清单，副行 hover 可换成「查看更改」。
  const single = record !== null && files.length === 1
  // 清单窗口：hiddenCount 恒按折叠态计算，展开后按钮仍在（否则无法收起）。
  const window = files.length > 1
    ? fileListWindow(files, expanded, TURNREWIND_VISIBLE_FILE_ROWS)
    : { visible: [], hiddenCount: 0 }
  const undone = card.kind === 'undone'
  const blocked = card.kind === 'failed' || card.kind === 'unavailable'
  const gitRequired = card.kind === 'git-required'

  const title = record !== null
    ? cardTitle(record, name => text('editedOne', { name }), count => text('editedMany', { count }))
    : text('unavailableTitle')

  /**
   * 原因码 → 人话。已知码走文案键；未知码（内核/宿主更新）原样显示——宁可显示一个
   * 生码，也不能显示空白或假装成功。
   */
  const explain = (reason: string | null | undefined): string => {
    const key = reasonKey(reason)
    return key !== null ? text(key) : (reason ?? '')
  }
  const unavailableReason = card.kind === 'failed' || card.kind === 'unavailable' ? card.reason : null
  // 「不在撤销范围内」的路径：宿主回传的条数有上限，因此只报数量，路径放在 title 里备查。
  const skippedOversized = record?.skippedOversized ?? []
  const skippedNestedRepos = record?.skippedNestedRepos ?? []

  const onUndo = (): void => {
    if (gitRequired) {
      setDialogOpen(true)
      return
    }
    if (blocked || state.undoing || turn === undefined)
      return
    void requestUndo(sessionId, turn)
  }

  /*
    「打开文件」：只在**具备应用内右侧边栏能力**的内核上生效（新核心 = 侧边栏预览页签）。
    旧核心虽然也派发 openFile，但它会把路径交给宿主/系统去打开，需求要求那里保持静默；
    判据与理由见 client/capabilities/index.ts 与 client/utils/open-file.ts。
    能力缺席时标题与清单行渲染成不可点的普通元素（不给「点了没反应」的假交互）。
  */
  const onOpenFile = fileOpenHandler({ openFile: props.openFile, sidebarPreview: hasSidebarPreview() })
  const singlePath = single ? files[0]?.path : undefined
  const openLabel = (path: string): string => text('openFile', { name: path })

  /**
   * 清单行：具备打开能力时渲染成按钮，否则是不可点的普通行——
   * 不给「点了没反应」的假交互（旧内核上就是这一支）。
   */
  const renderFileRow = (file: TurnFileChange): ReactElement => {
    const deleted = file.status === 'D' ? ' dshp-turnrewind__file--deleted' : ''
    const className = `dshp-turnrewind__file${deleted}${onOpenFile === undefined ? '' : ' dshp-turnrewind__file--open'}`
    const label = `${file.path}  ${formatCounts(file, text('binary'))}`
    const content = (
      <>
        <span className="dshp-turnrewind__file-path">{file.path}</span>
        <span className="dshp-turnrewind__file-counts">
          <ChangeCounts
            insertions={file.insertions}
            deletions={file.deletions}
            binary={file.binary}
            binaryLabel={text('binary')}
          />
        </span>
      </>
    )
    if (onOpenFile === undefined) {
      return (
        <div key={file.path} className={className} data-status={file.status} title={label}>
          {content}
        </div>
      )
    }
    return (
      <button
        key={file.path}
        type="button"
        className={className}
        data-status={file.status}
        title={label}
        aria-label={openLabel(file.path)}
        onClick={() => onOpenFile(file.path)}
      >
        {content}
      </button>
    )
  }

  return (
    <div className="dshp-turnrewind">
      <div
        className={`dshp-turnrewind__card${single ? ' dshp-turnrewind__card--single' : ''}`}
        data-turnrewind-card={String(turn ?? '')}
      >
        <div className="dshp-turnrewind__head">
          {/* 占位：📝 文件图标块不做任何事（需求：文件按钮仅做占位）。 */}
          <span className="dshp-turnrewind__icon" title={text('fileButton')} aria-label={text('fileButton')} data-placeholder="file">
            <Icon as={SquarePlus} size={18} />
          </span>
          <div className="dshp-turnrewind__meta">
            {onOpenFile !== undefined && singlePath !== undefined
              ? (
                  <button
                    type="button"
                    className="dshp-turnrewind__title dshp-turnrewind__title--link"
                    title={singlePath}
                    aria-label={openLabel(singlePath)}
                    onClick={() => onOpenFile(singlePath)}
                  >
                    {title}
                  </button>
                )
              : <span className="dshp-turnrewind__title" title={title}>{title}</span>}
            <span className="dshp-turnrewind__sub">
              {record !== null
                ? (
                    <>
                      <span className="dshp-turnrewind__counts" title={formatTotals(record)}>
                        <ChangeCounts
                          insertions={record.insertions}
                          deletions={record.deletions}
                          binary={false}
                          binaryLabel={text('binary')}
                        />
                      </span>
                      {/*
                        TODO(view-changes-hover): hover 显示「查看更改」暂时整体停用（需求方要求），
                        当前只显示 +xx -x。注意：「打开文件」已单独开放（点击标题 / 清单行即可），
                        但**没有**因此加回任何 hover 视觉——恢复本项时要保持这两件事彼此独立。
                        恢复时注意三条：
                          1. 单文件与**多文件**的 __head 都要有该 hover 效果（不再用 single 条件限定）；
                          2. 重新从 dsh-tauri-ui/client 引入 ArrowUpRight 图标；
                          3. cssr 里把 `.dshp-turnrewind__card:hover` 下的
                             `__counts` 隐藏 / `__hint` 显示两条规则恢复（现在已注释）。
                        {single && (
                          <span className="dshp-turnrewind__hint" data-placeholder="view-changes">
                            {text('viewChanges')}
                            <Icon as={ArrowUpRight} size={14} />
                          </span>
                        )}
                      */}
                    </>
                  )
                : (
                    <span className="dshp-turnrewind__hint-text">
                      {gitRequired ? text('unavailableGitDesc') : explain(unavailableReason)}
                    </span>
                  )}
            </span>
          </div>
          <span className="dshp-turnrewind__spacer" />
          {/* 已撤销：只留「已撤销」徽标，撤销按钮不再出现（避免看起来还能再撤一次）。 */}
          {undone
            ? <span className="dshp-turnrewind__badge">{text('undoneBadge')}</span>
            : (
                <button
                  type="button"
                  className="dshp-turnrewind__undo"
                  disabled={blocked || state.undoing}
                  onClick={onUndo}
                  title={text('undo')}
                >
                  {state.undoing ? text('undoing') : text('undo')}
                  <Icon as={ArrowUturnCcwLeft} size={14} />
                </button>
              )}
          {/*
            TODO(review-action): 「审核」占位按钮暂时整体隐藏（需求方要求），
            重新启用时注意：已撤销的 turn 不应再显示它（那时已无变更可审）。
            <button type="button" className="dshp-turnrewind__review" data-placeholder="review" title={text('review')}>
              {text('review')}
            </button>
          */}
        </div>

        {window.visible.length > 0 && (
          <div className="dshp-turnrewind__files">
            {window.visible.map(file => renderFileRow(file))}
          </div>
        )}

        {/* 折叠控件始终存在（展开后是「收起文件」），否则展开就没有回头路。 */}
        {window.hiddenCount > 0 && (
          <button type="button" className="dshp-turnrewind__more" onClick={() => setExpandedTurn(current => (current === turn ? undefined : turn))}>
            {expanded ? text('collapseFiles') : text('moreFiles', { count: window.hiddenCount })}
            <Icon as={expanded ? ChevronUp : ChevronDown} size={14} />
          </button>
        )}

        {/* 「不在撤销范围内」的路径必须如实标注：静默漏掉会让用户以为撤销是完整的。 */}
        {(skippedOversized.length > 0 || skippedNestedRepos.length > 0) && (
          <div className="dshp-turnrewind__notice dshp-turnrewind__notice--skip">
            {skippedOversized.length > 0 && (
              <div data-skipped="oversized" title={skippedOversized.join('\n')}>
                {text('skippedOversized', { count: skippedOversized.length })}
              </div>
            )}
            {skippedNestedRepos.length > 0 && (
              <div data-skipped="nested" title={skippedNestedRepos.join('\n')}>
                {text('skippedNestedRepos', { count: skippedNestedRepos.length })}
              </div>
            )}
          </div>
        )}

        {state.undoError !== null && (
          <div className="dshp-turnrewind__notice dshp-turnrewind__notice--error">
            <div>{text('undoFailed', { reason: explain(state.undoError) })}</div>
            {state.undoConflicts.length > 0 && (
              <>
                <div>{text('conflictTitle')}</div>
                <ul className="dshp-turnrewind__conflict-list">
                  {state.undoConflicts.map(conflict => (
                    <li key={conflict.path} className="dshp-turnrewind__conflict-item" title={conflict.path}>{conflict.path}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
      <GitRequiredDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  )
}
