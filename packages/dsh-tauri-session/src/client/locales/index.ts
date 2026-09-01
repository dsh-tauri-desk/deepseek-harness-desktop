/**
 * client/locales/index.ts — 本插件自有文案（归档设置页 / 归档工作区按钮）。
 * 走 locale 服务的非类型化注册面（register(ns, locale, dict)），zh/en 双语齐备。
 */
import type { ClientContext } from 'dsh-tauri/client'
import type { LocaleKey } from '../types'
import { createExternalStore } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { SESSION_CLIENT_NS as NS } from '../constants'

export { SESSION_CLIENT_NS as NS } from '../constants'

/** zh 字典（键集合的权威）。 */
const DICT_ZH = {
  section: '归档',
  archiveTitle: '已归档的聊天',
  deleteAll: '全部删除',
  searchPlaceholder: '搜索已归档的聊天',
  sortLabel: '排序方式',
  sortUpdatedAt: '更新时间',
  sortCreatedAt: '创建时间',
  sortTitle: '按字母排序',
  allProjects: '所有项目',
  ungrouped: '未分组',
  unarchive: '取消归档',
  empty: '没有已归档的聊天',
  noResults: '没有匹配的聊天',
  loadFailed: '加载失败',
  chats: '个聊天',
  groupMenuAria: '项目操作',
  deleteProjectChats: '删除项目中的全部会话',
  deleteProjectTitle: '删除该项目中的所有聊天？',
  deleteProjectBody: '这将永久删除「{workspace}」中的 {count} 条本地已归档聊天',
  archiveWorkspace: '归档会话',
  archiveWorkspaceMenu: '归档工作区',
  archiveWorkspaceTitle: '归档 {count} 个会话？',
  archiveWorkspaceDescription: '这会将 {workspace} 中的会话归档。之后你可以在已归档的会话中找到它们',
  archiveWorkspaceConfirm: '全部归档',
  cancel: '取消',
  close: '关闭',
  deleteConfirm: '删除',
  deleteRowAria: '删除此会话',
  deleteSingleTitle: '删除已归档聊天？',
  deleteSingleBody: '这将永久删除已归档聊天',
  deleteAllTitle: '删除所有已归档本地聊天？',
  deleteAllBody: '这将永久删除所有本地已归档聊天记录',
  loading: '处理中…',
  unarchivedToast: '对话已取消归档',
  view: '查看',
  untitled: '未命名会话',
  requestFailed: '请求失败 ({status})',
  requestTimeout: '请求超时，请检查会话插件是否已加载最新版本',
} as const satisfies Record<LocaleKey, string>

/** en 字典，与 zh 键集完全一致（locale 运行时强制双语平衡）。 */
const DICT_EN: Record<LocaleKey, string> = {
  section: 'Archive',
  archiveTitle: 'Archived chats',
  deleteAll: 'Delete all',
  searchPlaceholder: 'Search archived chats',
  sortLabel: 'Sort by',
  sortUpdatedAt: 'Updated time',
  sortCreatedAt: 'Created time',
  sortTitle: 'Alphabetical',
  allProjects: 'All projects',
  ungrouped: 'Ungrouped',
  unarchive: 'Unarchive',
  empty: 'No archived chats',
  noResults: 'No matching chats',
  loadFailed: 'Failed to load',
  chats: 'chats',
  groupMenuAria: 'Project actions',
  deleteProjectChats: 'Delete all chats in project',
  deleteProjectTitle: 'Delete all chats in this project?',
  deleteProjectBody: 'This will permanently delete {count} locally archived chats in “{workspace}”.',
  archiveWorkspace: 'Archive sessions',
  archiveWorkspaceMenu: 'Archive workspace',
  archiveWorkspaceTitle: 'Archive {count} sessions?',
  archiveWorkspaceDescription: 'This will archive the sessions in {workspace}. You can find them in Archived sessions afterwards.',
  archiveWorkspaceConfirm: 'Archive all',
  cancel: 'Cancel',
  close: 'Close',
  deleteConfirm: 'Delete',
  deleteRowAria: 'Delete this session',
  deleteSingleTitle: 'Delete archived chat?',
  deleteSingleBody: 'This will permanently delete the archived chat.',
  deleteAllTitle: 'Delete all archived chats?',
  deleteAllBody: 'This will permanently delete all locally archived chat records.',
  loading: 'Working…',
  unarchivedToast: 'Chat unarchived',
  view: 'View',
  untitled: 'Untitled session',
  requestFailed: 'Request failed ({status})',
  requestTimeout: 'Request timed out. Check that the session plugin is up to date.',
}

/** 活跃语言 id（module 级缓存，apply 时初始化并由订阅推进）。 */
let activeLocale = 'en'

/** 当前是否使用英文界面（格式化函数读取，避免导出可变绑定）。 */
export function isEnglishLocale(): boolean {
  return activeLocale === 'en'
}

/** locale 变更推进器：revision 前进 -> uSES 订阅方重渲染。 */
export const localeRev = createExternalStore({ rev: 0 })

/**
 * 在 apply 里安装：注册双语字典，并桥接 locale 变更到 rev。
 * @param ctx - 客户端根上下文（须已注入 locale 服务）。
 */
export function installLocale(ctx: ClientContext): void {
  activeLocale = ctx.locale.getLocale().active
  ctx.locale.register(NS, 'zh', DICT_ZH)
  ctx.locale.register(NS, 'en', DICT_EN)
  ctx.locale.subscribe(() => {
    activeLocale = ctx.locale.getLocale().active
    localeRev.set(state => ({ ...state, rev: state.rev + 1 }))
  })
}

/** 按当前活跃语言取一条文案。 */
export function text(key: LocaleKey, values: Record<string, string | number> = {}): string {
  const template = activeLocale === 'en' ? DICT_EN[key] : DICT_ZH[key]
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))
}

/** 组件内订阅 locale 变更（revision 前进即重渲染）。 */
export function useLocale(): void {
  useSyncExternalStore(localeRev.subscribe, () => localeRev.getSnapshot().rev)
}
