/**
 * slots.ts — Alpha 兼容垫片：恢复 rc.2 客户端槽系统的「标准 props」类型契约。
 *
 * rc.2 的 `dsh-client-runtime` 通过 `declare module '@deepseek-ai/dsh-client-ui-slots'`
 * 把 `useSessions`/`useWorkspaces`/`useSession`/`sessionId`/`useProjection` 合并进
 * `GlobalStandardProps`/`SessionStandardProps`/`SessionMaybeStandardProps`，使各插件
 * 的槽组件 props 能声明这些标准钩子。alpha.3 的 `dsh-client-ui-slots` 把这三个 seat
 * 接口留空（具体成员由框架侧 UI 包——如 `dsh-client-ui-session`——合并），但桌面端
 * 插件（`dsh-tauri-panel` 独立行之外）并未安装这些 UI 系包。
 *
 * 本文件以「编译期类型契约」的形式恢复这些标准成员（运行时仍由框架注入，行为与
 * rc.2 一致），从而让桌面端插件在 alpha.3 编译下不改写槽组件即可通过类型检查。
 * 这是纯类型增广：不产生任何运行时副作用，向后兼容，alpha 与 rc.2 均安全。
 */

import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** 全局标准 seat：每个 root 作用域槽组件都收到这些钩子。 */
  interface GlobalStandardProps {
    /**
     * 会话列表快照选择器（rc.2 `useSessions` 标准钩子）。运行时由框架注入，
     * 事件来自 `ctx.sessions.list` 快照源。
     */
    useSessions: SnapshotSelectorHook<ReturnType<ISessions['list']['getSnapshot']>>
  }
}

export {}
