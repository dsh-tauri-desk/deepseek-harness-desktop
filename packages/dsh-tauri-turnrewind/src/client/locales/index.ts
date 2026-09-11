/**
 * client/locales/index.ts — 本插件界面文案（zh / en 双语）。
 *
 * 用 locale 服务的非类型化注册面（register(ns, locale, dict)）挂进 dsh 的 locale 表：
 * zh/en 键集齐全即满足运行时双语平衡约束，无需增广 LocaleNamespaceMap（两内核的
 * locale 服务都同时支持 3 参与 2 参重载，已核实实现逐字一致）。
 * 组件侧不取框架 `t` 座，改用极薄的 uSES 桥（与 dsh-tauri-worktree 同款）：
 * apply 时订阅 locale 变更推进 rev，组件订阅 rev 重渲染。
 */

import type { ClientContext } from 'dsh-tauri/client'
import type { LocaleKey } from '../types'
import { createExternalStore } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { TURNREWIND_LOCALE_NAMESPACE as NS } from '../constants'

export { TURNREWIND_LOCALE_NAMESPACE as NS } from '../constants'
export type { LocaleKey } from '../types'

/** zh 字典（键集合的权威）。 */
const DICT_ZH = {
  fileButton: '文件',
  editedOne: '已编辑 {name}',
  editedMany: '已编辑 {count} 个文件',
  undo: '撤销',
  undoing: '撤销中…',
  review: '审核',
  viewChanges: '查看更改',
  moreFiles: '再显示 {count} 个文件',
  collapseFiles: '收起文件',
  undoneBadge: '已撤销',
  runningChanged: '{count} 个文件已更改',
  binary: '二进制',
  unavailableTitle: '撤销不可用',
  unavailableReason: '原因：{reason}',
  undoFailed: '撤销失败：{reason}',
  conflictTitle: '以下文件在撤销前又被修改，已拒绝执行（未改动任何文件）：',
  expiredReason: '该轮的快照已被回收（超出保留范围，或快照仓因超限被重建），无法撤销。',
  gitUnavailableReason: '未找到 git 可执行文件，请先安装 Git 并使其在 PATH 中可用。',
  turnActiveReason: '该轮仍在运行中，结束后才能撤销。',
  snapshotFailedReason: '该轮的快照没能生成（捕获或统计过程失败），因此无法撤销。',
  unsafePathReason: '目标路径上有符号链接或非空目录，出于安全考虑拒绝撤销。',
  skippedOversized: '{count} 个超大文件未纳入快照，撤销不会改动它们',
  skippedNestedRepos: '{count} 个嵌套仓库已跳过，撤销不会改动其内部文件',
  openFile: '打开 {name}',
} as const satisfies Record<LocaleKey, string>

/** en 字典，与 zh 键集完全一致（locale 运行时强制双语平衡）。 */
const DICT_EN: Record<LocaleKey, string> = {
  fileButton: 'Files',
  editedOne: 'Edited {name}',
  editedMany: 'Edited {count} files',
  undo: 'Undo',
  undoing: 'Undoing…',
  review: 'Review',
  viewChanges: 'View changes',
  moreFiles: 'Show {count} more files',
  collapseFiles: 'Collapse files',
  undoneBadge: 'Undone',
  runningChanged: '{count} file(s) changed',
  binary: 'binary',
  unavailableTitle: 'Undo unavailable',
  unavailableReason: 'Reason: {reason}',
  undoFailed: 'Undo failed: {reason}',
  conflictTitle: 'These files changed again before the undo — the undo was refused and no file was modified:',
  expiredReason: 'This turn’s snapshot has been reclaimed (beyond the retention window, or the snapshot repository was rebuilt after exceeding its size limit), so it cannot be undone.',
  gitUnavailableReason: 'The git executable was not found. Install Git and make it available on PATH.',
  turnActiveReason: 'This turn is still running; it can be undone once it finishes.',
  snapshotFailedReason: 'No snapshot could be produced for this turn (the capture or the diff failed), so it cannot be undone.',
  unsafePathReason: 'A symbolic link or a non-empty directory sits on the target path, so the undo was refused for safety.',
  skippedOversized: '{count} oversized file(s) were not captured — undoing will not touch them',
  skippedNestedRepos: '{count} nested repository/repositories skipped — undoing will not touch their contents',
  openFile: 'Open {name}',
}

/** 活跃语言 id（module 级缓存，apply 时初始化并由订阅推进）。 */
let activeLocale = 'en'

/** locale 变更推进器：revision 前进 → uSES 订阅方重渲染。 */
export const localeRev = createExternalStore({ rev: 0 })

/**
 * 在 apply 里安装：注册本插件双语字典，并把 locale 变更桥接到 rev。
 * @param ctx - 客户端根上下文（须已注入 locale 服务）。
 * @returns 注销订阅的 disposer（交给 ctx.effect 管理）。
 */
export function registerLocale(ctx: ClientContext): () => void {
  activeLocale = ctx.locale.getLocale().active
  ctx.locale.register(NS, 'zh', DICT_ZH)
  ctx.locale.register(NS, 'en', DICT_EN)
  const off = ctx.locale.subscribe(() => {
    activeLocale = ctx.locale.getLocale().active
    localeRev.set(state => ({ ...state, rev: state.rev + 1 }))
  })
  return typeof off === 'function' ? off : () => {}
}

/** 取一条文案并填充 `{name}` 占位。 */
export function text(key: LocaleKey, params?: Record<string, string | number>): string {
  const dict: Record<LocaleKey, string> = activeLocale === 'en' ? DICT_EN : DICT_ZH
  const template = dict[key]
  if (params === undefined)
    return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    (name in params ? String(params[name]) : match))
}

/** 组件内订阅 locale 变更（revision 前进即重渲染）。 */
export function useLocale(): void {
  useSyncExternalStore(localeRev.subscribe, () => localeRev.getSnapshot().rev)
}
