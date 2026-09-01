/**
 * register/dialog.ts — 检出本地 / 放弃更改 两个模态框的 slot 注册。
 *
 * 注册进 shell.overlay（list）新增一个条目；effect 生命周期内清理 inject 句柄。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WorktreeDialogProps } from '../types'
import { compat } from 'dsh-tauri/client'
import { WorktreeDialog } from '../components/dialog'
import { DIALOG_EFFECT, DIALOG_ID, SHELL_OVERLAY_SLOT, WORKTREE_PLUGIN_NAME } from '../constants'

/**
 * 注册：shell.overlay（list）新增一个条目，渲染检出/放弃弹窗。
 * @param ctx - 客户端根上下文。
 */
export function registerDialog(ctx: Context): void {
  const cx = compat(ctx as import('dsh-tauri/client').ClientContext)
  // shell.overlay 由 ui-layout 的 AppFrame 声明；alpha 要求注册进入前该槽已由
  // 父条目 children 表声明，故用 inject 等其声明 live 后再注册。
  ctx.effect(
    () =>
      ctx.slots.inject(SHELL_OVERLAY_SLOT, () =>
        ctx.slots.register(
          {
            name: SHELL_OVERLAY_SLOT,
            id: DIALOG_ID,
            registrant: WORKTREE_PLUGIN_NAME,
            inject: (): Pick<WorktreeDialogProps, 'sessionsRuntime' | 'workspacesRuntime'> => ({
              // cx.sessions/cx.workspaces 在 alpha 解析为宿主服务面（SessionStore/IWorkspaces），
              // 投影到 WorktreeDialogProps 所需的轻量运行时读写面。
              workspacesRuntime: cx.workspaces as unknown as WorktreeDialogProps['workspacesRuntime'],
              sessionsRuntime: cx.sessions as unknown as WorktreeDialogProps['sessionsRuntime'],
            }),
          },
          WorktreeDialog,
        )),
    DIALOG_EFFECT,
  )
}
