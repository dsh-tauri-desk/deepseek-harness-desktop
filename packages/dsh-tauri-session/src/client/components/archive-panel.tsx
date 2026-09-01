import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
/**
 * archive-panel.tsx — 设置页「归档」分区内容（已归档的聊天）。
 *
 * 布局（参照需求截图）：
 *   标题「已归档的聊天」 + 右上「全部删除」（危险色）；
 *   工具条：搜索框 / 排序方式下拉（官方 primitives Input + Menu 组件）；
 *   分组列表：每行左侧竖排「标题 + 时间」（标题加粗），右侧「垃圾桶（彻底删除）
 *   + 取消归档」按钮。删除均为破坏性操作，经官方 Modal 二次确认（单项 / 全部）。
 *
 * 数据源：宿主归档集合。列表 id 取「GET /archived 载荷 ∪ 客户端 workspace 快照的
 * archivedSessionIds」——后者随宿主帧实时镜像官方「归档」动作，保证用户刚用官方
 * 菜单归档的会话立刻出现在本页。
 *
 * 变更期间（unarchive/delete/clear）页面进入 pending：动作按钮禁用并弹 loading
 * toast；取消归档成功后弹「对话已取消归档 [查看]」，查看可跳转到恢复的会话。
 *
 * 职责拆分：行构建 / 去重 / 时间格式化等纯逻辑在 lib/archive-rows.ts 与
 * lib/sort.ts；本组件只保留展示与交互编排。
 */
import type { ReactElement } from 'react'
import type { ArchivePanelProps, ArchiveSort } from '../types'
import { Button, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { SESSION_CLASSES as K } from '../constants'
import { text, useLocale } from '../locales'
import {
  archiveStore,
  clearArchive,
  deleteSession,
  deleteWorkspaceSessions,
  refreshArchived,
  setQuery,
  setSort,
  setWorkspaceFilter,
  unarchiveSession,
  useArchiveUi,
} from '../store'
import { buildRows, formatTime, projectOptions, unionIds } from '../utils/archive-rows'
import { groupArchive } from '../utils/sort'
import { IconEllipsis, IconFolderOpen, IconMagnifier, IconTrashBin } from './icons'
import { MenuSelect } from './menu-select'

/** 打开的删除确认弹窗：null 关闭；'single' 删除单个会话；'all' 删除全部。 */
type DeleteConfirm = null | { kind: 'single', sessionId: string } | { kind: 'all' } | { kind: 'workspace', workspaceTitle: string, sessionIds: string[] }

/** 设置页「归档」分区。 */
export function ArchivePanel(props: ArchivePanelProps): ReactElement | null {
  const ui = useArchiveUi()
  useLocale()
  const [confirm, setConfirm] = useState<DeleteConfirm>(null)
  const [openGroupMenu, setOpenGroupMenu] = useState<string | null>(null)

  const sessions = useSyncExternalStore(props.sessionsRuntime.list.subscribe, props.sessionsRuntime.list.getSnapshot)
  const workspaces = useSyncExternalStore(props.workspacesRuntime.list.subscribe, props.workspacesRuntime.list.getSnapshot)

  // 变更走宿主注册表内部状态机，不产生官方 changed frame；成功后手动重拉镜像。
  const resyncWorkspaces = useCallback(() => {
    return props.workspacesRuntime.manager?.refresh?.() ?? Promise.resolve()
  }, [props.workspacesRuntime])
  const refreshSessions = useCallback(() => {
    return props.sessionsRuntime.refresh?.() ?? Promise.resolve()
  }, [props.sessionsRuntime])

  // 进入分区或宿主归档集合规模变化时刷新归档载荷（meta：createdAt/cwd）。
  const archivedCount = (workspaces.archivedSessionIds ?? []).length
  useEffect(() => {
    void refreshArchived()
  }, [archivedCount])

  const archivedIds = unionIds(ui.archived.archivedSessionIds, workspaces.archivedSessionIds ?? [])
    .filter(id => !ui.suppressedSessionIds.includes(id))
  const rows = buildRows(archivedIds, ui.archived.meta, sessions, workspaces, ui.titleById)
  useEffect(() => {
    const titles: Record<string, string> = {}
    for (const row of rows)
      titles[row.sessionId] = row.title
    const current = archiveStore.getSnapshot().titleById
    if (Object.entries(titles).some(([id, title]) => current[id] !== title)) {
      archiveStore.set(state => ({
        ...state,
        titleById: { ...state.titleById, ...titles },
      }))
    }
  }, [rows])

  const query = ui.query.trim().toLowerCase()
  const filtered = query
    ? rows.filter(row =>
        row.title.toLowerCase().includes(query)
        || (row.cwd ?? '').toLowerCase().includes(query)
        || (row.workspaceTitle ?? '').toLowerCase().includes(query))
    : rows

  const visible = ui.workspaceId === 'all'
    ? filtered
    : filtered.filter(row => ui.workspaceId === 'ungrouped' ? !row.workspaceId : row.workspaceId === ui.workspaceId)

  const groups = groupArchive(visible, ui.sort, text('ungrouped'))

  const busy = ui.pending || ui.loading

  /** 取消归档：成功后弹「对话已取消归档 [查看]」。 */
  function handleUnarchive(sessionId: string): void {
    void unarchiveSession(sessionId, resyncWorkspaces)
  }

  /** 确认弹窗的删除动作（单项 / 全部）。 */
  function handleConfirmDelete(): void {
    const active = confirm
    setConfirm(null)
    if (active?.kind === 'single') {
      void deleteSession(active.sessionId, async () => {
        await refreshSessions()
        await resyncWorkspaces()
      })
    }
    else if (active?.kind === 'all') {
      void clearArchive(async () => {
        await refreshSessions()
        await resyncWorkspaces()
      })
    }
    else if (active?.kind === 'workspace') {
      void deleteWorkspaceSessions(active.sessionIds, async () => {
        await refreshSessions()
        await resyncWorkspaces()
      })
    }
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={() => setConfirm(null)}>{text('cancel')}</Button>
      <Button
        variant="outline"
        className={K.deleteBtn}
        disabled={ui.pending}
        onClick={handleConfirmDelete}
      >
        {text('deleteConfirm')}
      </Button>
    </>
  )

  return (
    <div className={K.page}>
      <div className={K.header}>
        <h1 className={K.title}>{text('archiveTitle')}</h1>
        <Button
          type="button"
          variant="ghost"
          icon={<IconTrashBin />}
          className={K.deleteAll}
          style={{ color: 'var(--dsw-alias-state-error-primary)' }}
          disabled={busy}
          onClick={() => setConfirm({ kind: 'all' })}
        >
          <span className={K.deleteBtnText}>{text('deleteAll')}</span>
        </Button>
      </div>

      <div className={K.toolbar}>
        <Input
          className={K.search}
          value={ui.query}
          placeholder={text('searchPlaceholder')}
          aria-label={text('searchPlaceholder')}
          icon={<IconMagnifier />}
          onChange={event => setQuery(event.target.value)}
        />
        <MenuSelect
          label={text('sortLabel')}
          value={ui.sort}
          onSelect={id => setSort(id as ArchiveSort)}
          options={[
            { id: 'updatedAt', label: text('sortUpdatedAt') },
            { id: 'createdAt', label: text('sortCreatedAt') },
            { id: 'title', label: text('sortTitle') },
          ]}
        />
        <MenuSelect
          label={text('allProjects')}
          value={ui.workspaceId}
          onSelect={setWorkspaceFilter}
          options={[
            { id: 'all', label: text('allProjects') },
            ...[...projectOptions(rows).entries()].map(([id, title]) => ({ id, label: title })),
            ...(rows.some(row => !row.workspaceId) ? [{ id: 'ungrouped', label: text('ungrouped') }] : []),
          ]}
        />
      </div>

      {ui.error && <div className={K.error}>{ui.error}</div>}

      {!ui.loading && visible.length === 0 && (
        <div className={K.empty}>{query ? text('noResults') : text('empty')}</div>
      )}

      <div className={K.groups}>
        {groups.map(group => (
          <section key={group.id} className={K.group}>
            <div className={K.groupHeader}>
              <IconFolderOpen />
              <span className={K.groupTitle}>{group.title || text('ungrouped')}</span>
              <span className={K.groupCount}>
                {group.rows.length}
                {' '}
                {text('chats')}
              </span>
              <Menu
                open={openGroupMenu === group.id}
                onClose={() => setOpenGroupMenu(null)}
                onSelect={(id) => {
                  setOpenGroupMenu(null)
                  if (id === 'delete') {
                    setConfirm({
                      kind: 'workspace',
                      workspaceTitle: group.title || text('ungrouped'),
                      sessionIds: rows.filter(row => group.id === 'ungrouped' ? !row.workspaceId : row.workspaceId === group.id).map(row => row.sessionId),
                    })
                  }
                }}
                items={[{
                  id: 'delete',
                  label: text('deleteProjectChats'),
                  icon: <IconTrashBin />,
                  danger: true,
                } satisfies MenuEntry]}
                portal
                align="end"
                anchor={(
                  <button
                    type="button"
                    className={K.groupMenuTrigger}
                    aria-label={text('groupMenuAria')}
                    aria-haspopup="menu"
                    aria-expanded={openGroupMenu === group.id}
                    onClick={() => setOpenGroupMenu(openGroupMenu === group.id ? null : group.id)}
                  >
                    <IconEllipsis />
                  </button>
                )}
              />
            </div>
            <ul className={K.list}>
              {group.rows.map(row => (
                <li key={row.sessionId} className={K.row}>
                  <div className={K.rowMain}>
                    <span className={K.rowTitle}>{row.title}</span>
                    <span className={K.rowTime}>{formatTime(row)}</span>
                  </div>
                  <div className={K.rowActions}>
                    <button
                      type="button"
                      className={K.rowDelete}
                      aria-label={text('deleteRowAria')}
                      disabled={busy}
                      onClick={() => setConfirm({ kind: 'single', sessionId: row.sessionId })}
                    >
                      <IconTrashBin />
                    </button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={K.unarchive}
                      disabled={busy}
                      onClick={() => handleUnarchive(row.sessionId)}
                    >
                      {text('unarchive')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <Modal
        open={confirm?.kind === 'single'}
        onClose={() => setConfirm(null)}
        title={text('deleteSingleTitle')}
        description={text('deleteSingleBody')}
        footer={footer}
      />
      <Modal
        open={confirm?.kind === 'all'}
        onClose={() => setConfirm(null)}
        title={text('deleteAllTitle')}
        description={text('deleteAllBody')}
        footer={footer}
      />
      <Modal
        open={confirm?.kind === 'workspace'}
        onClose={() => setConfirm(null)}
        title={text('deleteProjectTitle')}
        description={confirm?.kind === 'workspace' ? text('deleteProjectBody', { count: confirm.sessionIds.length, workspace: confirm.workspaceTitle }) : ''}
        footer={footer}
      />
    </div>
  )
}
