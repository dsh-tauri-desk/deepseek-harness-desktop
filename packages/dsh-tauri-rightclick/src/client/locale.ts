/**
 * locale.ts — 本插件自有文案（右键菜单 / Toast / 确认框 / 错误提示）。
 * 走 locale 服务的非类型化注册面（register(ns, locale, dict)），zh/en 双语齐备，
 * 语言自动跟随宿主 UI；`text()` 支持 `{name}` 插值（如归档确认框的标题/数量）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleKey } from './types'
import { RIGHTCLICK_CLIENT_NS as NS } from './constants'

export { RIGHTCLICK_CLIENT_NS as NS } from './constants'

/** zh 字典（键集合的权威）。 */
const DICT_ZH = {
  renameSession: '重命名会话',
  archiveSession: '归档会话',
  openInExplorer: '在资源管理器中打开',
  copyWorkingDirectory: '复制工作目录',
  copySessionId: '复制会话 ID',
  forkSession: '创建会话分支',
  refresh: '刷新',
  newSession: '新建会话',
  renameWorkspace: '重命名工作区',
  copyWorkspacePath: '复制工作区路径',
  archiveWorkspaceSessions: '归档工作区',
  archiveUngroupedSessions: '归档未分组会话',
  undo: '撤销',
  redo: '重做',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
  copySelectedText: '复制所选文本',
  openInDefaultBrowser: '使用默认浏览器打开',
  copyLink: '复制链接',
  selectCurrentContent: '全选当前内容',
  copiedWorkingDirectory: '已复制工作目录',
  copiedSessionId: '已复制会话 ID',
  copiedWorkspacePath: '已复制工作区路径',
  sessionRenamed: '会话已重命名',
  sessionArchived: '会话已归档',
  copied: '已复制',
  cutDone: '已剪切',
  linkCopied: '已复制链接',
  noWorkspaceSessions: '该工作区没有可归档的会话',
  noUngroupedSessions: '未分组中没有可归档的正式会话',
  archiveWorkspaceTitle: '归档 {count} 个会话？',
  archiveWorkspaceDescription: '这会将 {workspace} 中的会话归档。之后你可以在已归档的会话中找到它们',
  archiveWorkspaceConfirmAction: '全部归档',
  archiveUngroupedTitle: '归档未分组中的 {count} 个会话？',
  archiveUngroupedDescription: '这会归档未分组中的全部正式会话',
  deleteWorkspace: '删除工作区',
  deleteWorkspaceTitle: '删除工作区？',
  deleteWorkspaceDescription: '将把“{title}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。',
  deleteWorkspaceConfirm: '删除',
  workspaceDeleted: '工作区已删除',
  cancel: '取消',
  workspaceSessionsArchived: '已归档 {count} 个会话',
  officialSessionActionUnavailable: '当前会话尚未提供该官方操作',
  officialWorkspaceActionUnavailable: '找不到官方工作区操作',
  openFailed: '打开失败: {reason}',
  unknownError: '未知错误',
  clipboardUnavailable: '剪贴板不可用',
  clipboardReadFailed: '无法读取剪贴板，请使用 Ctrl+V',
  useUndoShortcut: '请使用 Ctrl+Z 撤销',
  useRedoShortcut: '请使用 Ctrl+Y 重做',
  invalidLink: '链接地址无效',
  officialRenameUnavailable: '无法打开官方重命名窗口',
  officialWorkspaceRenameUnavailable: '无法打开官方工作区重命名窗口',
  officialArchiveUnavailable: '无法调用官方归档会话',
  officialForkUnavailable: '无法调用官方分叉会话',
  sessionUnknown: '无法确定当前会话',
  sessionNameEmpty: '会话名称不能为空',
  sessionServiceUnavailable: '无法取得官方会话服务',
  renameFailed: '重命名失败',
  editPositionUnknown: '无法确定编辑位置',
} as const satisfies Record<LocaleKey, string>

/** en 字典，与 zh 键集完全一致（locale 运行时强制双语平衡）。 */
const DICT_EN: Record<LocaleKey, string> = {
  renameSession: 'Rename session',
  archiveSession: 'Archive session',
  openInExplorer: 'Open in File Explorer',
  copyWorkingDirectory: 'Copy working directory',
  copySessionId: 'Copy session ID',
  forkSession: 'Fork session',
  refresh: 'Refresh',
  newSession: 'New session',
  renameWorkspace: 'Rename workspace',
  copyWorkspacePath: 'Copy workspace path',
  archiveWorkspaceSessions: 'Archive workspace',
  archiveUngroupedSessions: 'Archive ungrouped sessions',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
  copySelectedText: 'Copy selected text',
  openInDefaultBrowser: 'Open in default browser',
  copyLink: 'Copy link',
  selectCurrentContent: 'Select current content',
  copiedWorkingDirectory: 'Working directory copied',
  copiedSessionId: 'Session ID copied',
  copiedWorkspacePath: 'Workspace path copied',
  sessionRenamed: 'Session renamed',
  sessionArchived: 'Session archived',
  copied: 'Copied',
  cutDone: 'Cut',
  linkCopied: 'Link copied',
  noWorkspaceSessions: 'This workspace has no sessions to archive',
  noUngroupedSessions: 'Ungrouped has no formal sessions to archive',
  archiveWorkspaceTitle: 'Archive {count} sessions?',
  archiveWorkspaceDescription: 'This will archive the sessions in {workspace}. You can find them in Archived sessions afterwards.',
  archiveWorkspaceConfirmAction: 'Archive all',
  archiveUngroupedTitle: 'Archive {count} sessions in Ungrouped?',
  archiveUngroupedDescription: 'This will archive all formal sessions in Ungrouped.',
  deleteWorkspace: 'Delete workspace',
  deleteWorkspaceTitle: 'Delete workspace?',
  deleteWorkspaceDescription: 'This removes “{title}” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.',
  deleteWorkspaceConfirm: 'Delete',
  workspaceDeleted: 'Workspace deleted',
  cancel: 'Cancel',
  workspaceSessionsArchived: 'Archived {count} sessions',
  officialSessionActionUnavailable: 'The official action is not available for this session',
  officialWorkspaceActionUnavailable: 'Official workspace actions could not be found',
  openFailed: 'Failed to open: {reason}',
  unknownError: 'Unknown error',
  clipboardUnavailable: 'Clipboard is unavailable',
  clipboardReadFailed: 'Could not read the clipboard; use Ctrl+V',
  useUndoShortcut: 'Use Ctrl+Z to undo',
  useRedoShortcut: 'Use Ctrl+Y to redo',
  invalidLink: 'Invalid link URL',
  officialRenameUnavailable: 'Could not open the official rename dialog',
  officialWorkspaceRenameUnavailable: 'Could not open the official workspace rename dialog',
  officialArchiveUnavailable: 'Could not invoke the official archive action',
  officialForkUnavailable: 'Could not invoke the official fork action',
  sessionUnknown: 'Could not determine the current session',
  sessionNameEmpty: 'Session name cannot be empty',
  sessionServiceUnavailable: 'Official session service is unavailable',
  renameFailed: 'Rename failed',
  editPositionUnknown: 'Could not determine the editing position',
}

/** 活跃语言 id（module 级缓存，apply 时初始化并由订阅推进）。 */
let activeLocale = 'en'

/**
 * 在 apply 里安装：注册双语字典，并桥接 locale 变更到 module 级缓存。
 * @param ctx - 客户端根上下文（须已注入 locale 服务）。
 */
export function installLocale(ctx: Context): void {
  activeLocale = ctx.locale.getLocale().active
  ctx.locale.register(NS, 'zh', DICT_ZH)
  ctx.locale.register(NS, 'en', DICT_EN)
  ctx.locale.subscribe(() => {
    activeLocale = ctx.locale.getLocale().active
  })
}

/**
 * 按当前活跃语言取一条文案，并做 `{name}` 插值（缺失的值替换为空串）。
 * @param key - 文案键。
 * @param values - 插值表。
 */
export function text(key: LocaleKey, values: Record<string, string | number> = {}): string {
  const dict = activeLocale === 'en' ? DICT_EN : DICT_ZH
  return (dict[key] || DICT_EN[key] || key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
}
