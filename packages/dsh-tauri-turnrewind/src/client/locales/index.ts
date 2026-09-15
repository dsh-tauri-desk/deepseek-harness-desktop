/**
 * client/locales/index.ts — 本插件界面文案（zh / en 双语）。
 *
 * 一个包只声明一次：命名空间 + 双语词典 → `locale.text` / `locale.useLocale` /
 * `locale.registerLocale`。活跃语言是唯一可变事实，收敛在底座共享的 store 里，
 * 插件不再自建 locale 管理器或 revision store。
 */

import type { LocaleKey } from '../types'
import { defineLocale } from 'dsh-tauri/client'
import { TURNREWIND_PLUGIN_NAME } from '../constants'

/** zh 字典（键集合的权威）。 */
const zh = {
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
const en: Record<LocaleKey, string> = {
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

export const locale = defineLocale(TURNREWIND_PLUGIN_NAME, { zh, en })
