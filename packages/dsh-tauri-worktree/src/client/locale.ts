/**
 * locale.ts — 本插件自有的界面文案（模式选择 / Surface 提示 / 检出 / 放弃 / 处理状态）。
 *
 * 用 locale 服务的**非类型化**注册面（register(ns, locale, dict)）挂进 dsh 的 locale
 * 表：zh/en 双语齐全即满足运行时“bilingual balance”约束，无需增广 LocaleNamespaceMap。
 * 组件侧不引入框架 `t` 座，改用一个极薄的 uSES 桥：apply 时订阅 locale 变更推进 rev，
 * 组件订阅 rev 重渲染，文案按当前 active locale 从本地字典读取。
 */
import type { ClientContext } from 'dsh-tauri/client'
import type { LocaleKey } from './types'
import { createExternalStore } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { WORKTREE_LOCALE_NAMESPACE as NS } from './constants'

export { WORKTREE_LOCALE_NAMESPACE as NS } from './constants'
export type { LocaleKey } from './types'

/** zh 字典（键集合的权威）。 */
const DICT_ZH = {
  modeLabel: '工作模式',
  modeLocal: '本地',
  modeWorktree: '工作树',
  modeNewWorktree: '新建工作树',
  modeWorktreeDesc: '发送下一条消息时新建隔离 Git 工作树',
  modeLocalDesc: '在当前本地工作区处理',
  surfaceWorktree: '该会话正在工作树进行',
  surfaceCheckout: '检出本地',
  surfaceAbandon: '放弃',
  checkoutTitle: '将更改带回本地检出并继续',
  checkoutBranchLabel: '本地检出分支名',
  checkoutCurrentPath: '关联路径',
  checkoutTargetPath: '项目路径',
  checkoutConfirm: '确认检出',
  checkoutCancel: '取消',
  abandonTitle: '放弃工作树更改',
  abandonBody: '确认放弃吗？这将归档当前会话及删除对应的临时工作树。',
  abandonConfirm: '确认放弃',
  abandonCancel: '取消',
  progressCreating: '正在准备工作树',
  progressCheckingOut: '正在检出文件',
  progressCreated: '已创建工作树',
  progressViewLogs: '日志',
  progressThinking: '正在思考…',
  progressError: '工作树处理失败',
  branchPlaceholder: 'dsh/feature-xyz',
  logEmpty: '暂无创建日志',
  sessionWorkingTreeBadge: '工作树',
} as const satisfies Record<LocaleKey, string>

/** en 字典，与 zh 键集完全一致（locale 运行时强制双语平衡）。 */
const DICT_EN: Record<LocaleKey, string> = {
  modeLabel: 'Mode',
  modeLocal: 'Local',
  modeWorktree: 'Worktree',
  modeNewWorktree: 'New worktree',
  modeWorktreeDesc: 'Create an isolated Git worktree when the next message is sent',
  modeLocalDesc: 'Process in the current local workspace',
  surfaceWorktree: 'This session is running in a worktree',
  surfaceCheckout: 'Checkout local',
  surfaceAbandon: 'Abandon',
  checkoutTitle: 'Bring changes back to local and continue',
  checkoutBranchLabel: 'Local checkout branch name',
  checkoutCurrentPath: 'Current path',
  checkoutTargetPath: 'Target project path',
  checkoutConfirm: 'Confirm checkout & merge',
  checkoutCancel: 'Cancel',
  abandonTitle: 'Abandon worktree changes',
  abandonBody: 'Are you sure? This will archive this session and delete its temporary worktree.',
  abandonConfirm: 'Confirm abandon',
  abandonCancel: 'Cancel',
  progressCreating: 'Preparing workspace',
  progressCheckingOut: 'Checking out files',
  progressCreated: 'Workspace created',
  progressViewLogs: 'Logs',
  progressThinking: 'Thinking…',
  progressError: 'Worktree processing failed',
  branchPlaceholder: 'dsh/feature-xyz',
  logEmpty: 'No creation log yet',
  sessionWorkingTreeBadge: 'Worktree',
}

/** 活跃语言 id（module 级缓存，apply 时初始化并由订阅推进）。 */
let activeLocale = 'en'

/** locale 变更推进器：revision 前进 -> uSES 订阅方重渲染。 */
export const localeRev = createExternalStore({ rev: 0 })

/**
 * 在 apply 里安装：注册本插件的双语字典，并桥接 locale 变更到 rev。
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
export function text(key: LocaleKey): string {
  return activeLocale === 'en' ? DICT_EN[key] : DICT_ZH[key]
}

/** 组件内订阅 locale 变更（revision 前进即重渲染）。 */
export function useLocale(): void {
  useSyncExternalStore(localeRev.subscribe, () => localeRev.getSnapshot().rev)
}
