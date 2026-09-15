import type { ReactElement } from 'react'
import type { TurnFileChange } from '../types'
import type { TurnChangesCardProps } from './turn-changes-card.types'
import { ArrowUturnCcwLeft, ChevronDown, ChevronUp, FilePlus, Icon, useMountStyle } from 'dsh-tauri-ui/client'
import { useStore } from 'dsh-tauri/client'
/**
 * turn-changes-card.tsx — 一轮结束时渲染的变更卡片（视觉对齐官方 deliverables 行）。
 *
 * 职责拆分：槽位注册在 register/turn-tail.ts，数据在 store/ 与 service/，样式在 .cssr.ts，
 * 纯函数判定与格式化在 utils/format.ts，点击决策在 ./turn-changes-card.utils.ts。
 *
 * 交互边界（需求明确）：「撤销」、「再显示 N 个文件 / 收起文件」、点击文件打开、
 * 「审核」（新核心打开侧边栏文件树）是真功能；`📝 文件` 图标块是占位。
 * 两处按内核能力分流（判据与理由见 service/capabilities.ts）。
 */
import { useEffect, useState } from 'react'
import { TURNREWIND_CARD_STYLE_ID, TURNREWIND_COUNTS_STYLE_ID, TURNREWIND_SIDEBAR_FILES_KIND, TURNREWIND_VISIBLE_FILE_ROWS } from '../constants'
import { locale } from '../locales'
import { expectTurn } from '../service/summary'
import { undoTurn } from '../service/undo'
import { store } from '../store'
import { sessionStateOf } from '../store/modules/session.utils'
import countsStyle from '../styles/counts.cssr'
import { cardTitle, fileListWindow, formatCounts, formatTotals, reasonKey, resolveCardState } from '../utils/format'
import { ChangeCounts } from './change-counts'
import cardStyle from './turn-changes-card.cssr'
import { fileOpenHandler, reviewOpenHandler } from './turn-changes-card.utils'

export function TurnChangesCard(props: TurnChangesCardProps): ReactElement | null {
  useMountStyle(cardStyle, TURNREWIND_CARD_STYLE_ID)
  useMountStyle(countsStyle, TURNREWIND_COUNTS_STYLE_ID)
  locale.useLocale()
  const sessionId = props.sessionId
  const turn = props.matched?.turn ?? props.turn?.turn
  const capabilities = props.capabilities
  const state = sessionStateOf(useStore(store.turnrewind), sessionId)
  // 展开态按 turn 记账，而不是「effect 里复位布尔量」：卡片会被复用渲染下一轮，
  // 用 turn 作为天然的复位键（也避开 set-state-in-effect 的多余渲染）。
  const [expandedTurn, setExpandedTurn] = useState<number | undefined>(undefined)
  const expanded = expandedTurn !== undefined && expandedTurn === turn

  // keep:effect 摘要 Query 需要由卡片在第一帧发起（本轮是否已落账只有组件知道）
  useEffect(() => {
    void expectTurn({ sessionId, turn })
  }, [sessionId, turn])

  const card = resolveCardState(state.summary, turn)
  if (card.kind === 'hidden')
    return null

  const record = card.kind === 'ready' || card.kind === 'undone' ? card.record : null
  const files = record?.files ?? []
  // 单文件：标题即文件名、不渲染清单。
  const single = record !== null && files.length === 1
  // 清单窗口：hiddenCount 恒按折叠态计算，展开后按钮仍在（否则无法收起）。
  const window = files.length > 1
    ? fileListWindow(files, expanded, TURNREWIND_VISIBLE_FILE_ROWS)
    : { visible: [], hiddenCount: 0 }
  const undone = card.kind === 'undone'
  const blocked = card.kind === 'failed' || card.kind === 'unavailable'

  const title = record !== null
    ? cardTitle(record, name => locale.text('editedOne', { name }), count => locale.text('editedMany', { count }))
    : locale.text('unavailableTitle')

  /**
   * 原因码 → 人话。已知码走文案键；未知码（内核/宿主更新）原样显示——宁可显示一个生码，
   * 也不能显示空白或假装成功。
   */
  const explain = (reason: string | null | undefined): string => {
    const key = reasonKey(reason)
    return key !== null ? locale.text(key) : (reason ?? '')
  }
  const unavailableReason = card.kind === 'failed' || card.kind === 'unavailable' ? card.reason : null
  // 「不在撤销范围内」的路径：宿主回传的条数有上限，因此只报数量，路径放在 title 里备查。
  const skippedOversized = record?.skippedOversized ?? []
  const skippedNestedRepos = record?.skippedNestedRepos ?? []

  const onUndo = (): void => {
    if (blocked || state.undoing || turn === undefined)
      return
    void undoTurn({ sessionId, turn })
  }

  const onOpenFile = fileOpenHandler({ openFile: props.openFile, sidebarPreview: capabilities?.sidebarPreview ?? false })
  const singlePath = single ? files[0]?.path : undefined
  const openLabel = (path: string): string => locale.text('openFile', { name: path })

  const onReview = reviewOpenHandler({
    sidebar: capabilities?.sidebar,
    fileTree: capabilities?.fileTree ?? false,
    kind: TURNREWIND_SIDEBAR_FILES_KIND,
  })

  /**
   * 清单行：具备打开能力时渲染成按钮，否则是不可点的普通行——
   * 不给「点了没反应」的假交互（旧内核上就是这一支）。
   */
  const renderFileRow = (file: TurnFileChange): ReactElement => {
    const deleted = file.status === 'D' ? ' dshp-turnrewind__file--deleted' : ''
    const className = `dshp-turnrewind__file${deleted}${onOpenFile === undefined ? '' : ' dshp-turnrewind__file--open'}`
    const label = `${file.path}  ${formatCounts(file, locale.text('binary'))}`
    const content = (
      <>
        <span className="dshp-turnrewind__file-path">{file.path}</span>
        <span className="dshp-turnrewind__file-counts">
          <ChangeCounts
            insertions={file.insertions}
            deletions={file.deletions}
            binary={file.binary}
            binaryLabel={locale.text('binary')}
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
          <span className="dshp-turnrewind__icon" title={locale.text('fileButton')} aria-label={locale.text('fileButton')} data-placeholder="file">
            <Icon as={FilePlus} size={18} />
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
                    <span className="dshp-turnrewind__counts" title={formatTotals(record)}>
                      <ChangeCounts
                        insertions={record.insertions}
                        deletions={record.deletions}
                        binary={false}
                        binaryLabel={locale.text('binary')}
                      />
                    </span>
                  )
                : (
                    <span className="dshp-turnrewind__hint-text">
                      {explain(unavailableReason)}
                    </span>
                  )}
            </span>
          </div>
          <span className="dshp-turnrewind__spacer" />
          {/* 已撤销：只留「已撤销」徽标，撤销与「审核」都不再出现（没有可撤 / 可审的变更）。 */}
          {undone
            ? <span className="dshp-turnrewind__badge">{locale.text('undoneBadge')}</span>
            : (
                <>
                  <button
                    type="button"
                    className="dshp-turnrewind__undo"
                    disabled={blocked || state.undoing}
                    onClick={onUndo}
                    title={locale.text('undo')}
                  >
                    {state.undoing ? locale.text('undoing') : locale.text('undo')}
                    <Icon as={ArrowUturnCcwLeft} size={14} />
                  </button>
                  {/* 能力缺席（旧核心）时 `onReview` 为 undefined，整个按钮不渲染。 */}
                  {onReview !== undefined && (
                    <button
                      type="button"
                      className="dshp-turnrewind__review"
                      onClick={onReview}
                      title={locale.text('review')}
                    >
                      {locale.text('review')}
                    </button>
                  )}
                </>
              )}
        </div>

        {window.visible.length > 0 && (
          <div className="dshp-turnrewind__files">
            {window.visible.map(file => renderFileRow(file))}
          </div>
        )}

        {/* 折叠控件始终存在（展开后是「收起文件」），否则展开就没有回头路。 */}
        {window.hiddenCount > 0 && (
          <button type="button" className="dshp-turnrewind__more" onClick={() => setExpandedTurn(current => (current === turn ? undefined : turn))}>
            {expanded ? locale.text('collapseFiles') : locale.text('moreFiles', { count: window.hiddenCount })}
            <Icon as={expanded ? ChevronUp : ChevronDown} size={12} />
          </button>
        )}

        {/* 「不在撤销范围内」的路径必须如实标注：静默漏掉会让用户以为撤销是完整的。 */}
        {(skippedOversized.length > 0 || skippedNestedRepos.length > 0) && (
          <div className="dshp-turnrewind__notice dshp-turnrewind__notice--skip">
            {skippedOversized.length > 0 && (
              <div data-skipped="oversized" title={skippedOversized.join('\n')}>
                {locale.text('skippedOversized', { count: skippedOversized.length })}
              </div>
            )}
            {skippedNestedRepos.length > 0 && (
              <div data-skipped="nested" title={skippedNestedRepos.join('\n')}>
                {locale.text('skippedNestedRepos', { count: skippedNestedRepos.length })}
              </div>
            )}
          </div>
        )}

        {state.undoError !== null && (
          <div className="dshp-turnrewind__notice dshp-turnrewind__notice--error">
            <div>{locale.text('undoFailed', { reason: explain(state.undoError) })}</div>
            {state.undoConflicts.length > 0 && (
              <>
                <div>{locale.text('conflictTitle')}</div>
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
    </div>
  )
}
