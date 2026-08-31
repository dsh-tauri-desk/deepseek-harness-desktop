/**
 * dsh-tauri-session 客户端插件体（browser half）：「已归档的聊天」设置分区 +
 * 工作区浏览器的「删除工作区 → 归档工作区」替换。
 *
 * 两块功能：
 *   - archive-page.tsx  注册进 settings.section（导航项「归档」，经官方设置侧边栏
 *     投影出导航行），渲染归档列表页（搜索 / 排序 / 分组 / 项目选择 / 取消归档）；
 *     数据源为宿主归档集合（官方「归档」与「归档工作区」共用同一份数据）。
 *   - workspace-patch.ts  DOM 补丁：把官方项目行「…」菜单里的「删除工作区」改写为
 *     「归档工作区」，点击改为归档该组全部会话（portal 菜单条目拦截）。
 *
 * 与 node half（src/index.ts）经 /api/dsh-session/* 通信（archived/archive/
 * archive-workspace/unarchive/clear）。
 */
import type { ClientContext } from 'dsh-tauri/client'
import { compat } from 'dsh-tauri/client'
import {
  SESSION_ARCHIVE_PATCH_EFFECT,
  SESSION_ARCHIVE_SECTION_EFFECT,
  SESSION_REGISTRANT,
  SESSION_SECTION_ID,
  SESSION_SECTION_ORDER,
  SESSION_STYLES_EFFECT,
  SETTINGS_SECTION_SLOT,
} from './constants'
import { installLocale, text } from './locale'
import { ArchivePanel } from './panel'
import { mountSessionStyles } from './styles'
import { installWorkspaceArchivePatch } from './workspace-patch'

/** 插件显示名（诊断元数据）。 */
export const name = 'dsh-tauri-session'

/** 需要的客户端服务：slots / locale / sessions / workspaces。 */
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

/**
 * 插件体：安装文案与样式，注册「归档」设置分区，并安装工作区浏览器补丁。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const cx = compat(ctx)
  installLocale(cx)

  ctx.effect(() => mountSessionStyles(), SESSION_STYLES_EFFECT)

  // 1) 设置页「归档」分区（settings.section 单槽注册；导航行/内容由官方设置侧边栏投影）。
  // 'settings.section' 不在本插件类型图的 SlotMap 键（声明权在 ui-sidebar / ui-layout），
  // 此处对 options 显式 cast（先例：dsh-tauri-worktree 的 conversation.input.dock）。
  // alpha 要求注册进入前槽已由父条目 children 表声明：settings.section 由
  // ui-settings-general 的 sidebar.settings 条目声明，故用 inject 等其声明 live。
  ctx.effect(
    () =>
      ctx.slots.inject(SETTINGS_SECTION_SLOT as never, () =>
        ctx.slots.register(
          {
            name: SETTINGS_SECTION_SLOT,
            id: SESSION_SECTION_ID,
            order: SESSION_SECTION_ORDER,
            registrant: SESSION_REGISTRANT,
            label: () => text('section'),
            inject: () => ({ sessionsRuntime: cx.sessions, workspacesRuntime: cx.workspaces }),
          } as never,
          ArchivePanel,
        )),
    SESSION_ARCHIVE_SECTION_EFFECT,
  )

  // 2) 工作区浏览器补丁：替换「删除工作区」+ 隐藏归档会话行。
  ctx.effect(() => installWorkspaceArchivePatch(cx.workspaces as unknown as import('./types').WorkspacesRuntimeLike, cx.sessions as unknown as import('./types').SessionsRuntimeLike), SESSION_ARCHIVE_PATCH_EFFECT)
}
