import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext, WorkspaceId } from 'dsh-tauri/client'
import { resolveStartSession } from 'dsh-tauri/client'
import { SidebarRootClone } from '../components/sidebar'
import { NS } from '../locales'

/**
 * register/sidebar.ts — sidebar 槽整槽替换的安装器（priority -1 shadow 官方
 * ui-sidebar）；克隆组件见 components/sidebar.tsx。
 *
 * 等待 sidebar 槽声明（layout 的 AppFrame renderSlot("sidebar")）后，以
 * priority -1 shadow 官方 ui-sidebar 条目；children 仅声明新增的
 * sidebar.panel.action 协议槽。
 * @param ctx - 客户端根上下文。
 */
export function installSidebarRoot(ctx: Context): void {
  ctx.slots.inject('sidebar' as never, () =>
    ctx.slots.register(
      {
        name: 'sidebar',
        id: 'dsh-tauri-panel',
        priority: -1,
        locale: NS,
        children: {
          'sidebar.panel.action': { kind: 'list', scope: 'root' },
        },
        inject: () => ({
          startSession: (workspaceId?: WorkspaceId) => {
            const start = resolveStartSession(ctx as ClientContext)
            if (start === undefined) {
              console.error('[dsh-tauri-panel] new session unavailable: no workspace navigation service')
              return
            }
            void start(workspaceId)
          },
          toggleSidebar: () => ctx.layout.toggleSidebar(),
        }),
      } as never,
      SidebarRootClone,
    ))
}
