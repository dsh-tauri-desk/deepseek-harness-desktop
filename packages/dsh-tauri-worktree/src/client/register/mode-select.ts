/**
 * register/mode-select.ts — 「标准模式」右侧工作模式选择器的 slot 注册。
 *
 * 注册进 conversation.input.dock；inject 句柄随 effect 生命周期释放。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModeSelectProps, SessionsRuntime, WorkspacesRuntime } from '../types'
import { compat } from 'dsh-tauri/client'
import { WorktreeModeSelect } from '../components/mode-select'
import { INPUT_DOCK_SLOT, MODE_SELECT_ID, MODE_SELECT_ORDER } from '../constants'
import { NS } from '../locales'

/** 注入除标准槽位 props（useInput/inputActions）外的自定义注入面。 */
type ModeSelectInjected = Omit<ModeSelectProps, 'useInput' | 'inputActions'>

/** 使用 input.dock 的 session 生命周期，并把控件 portal 到标准模式右侧。 */
export function registerModeSelect(ctx: Context): () => void {
  const cx = compat(ctx as import('dsh-tauri/client').ClientContext)
  return ctx.slots.inject(INPUT_DOCK_SLOT as never, () =>
    ctx.slots.register(
      {
        name: INPUT_DOCK_SLOT,
        id: MODE_SELECT_ID,
        order: MODE_SELECT_ORDER,
        locale: NS,
        inject: (sessionId: string | undefined): ModeSelectInjected | undefined => sessionId === undefined
          ? undefined
          : {
              sessionId,
              sessionsRuntime: cx.sessions as unknown as SessionsRuntime,
              // 切换工作树成功后归档源会话（cx.workspaces 提供 archiveSession 服务面）。
              workspacesRuntime: cx.workspaces as unknown as WorkspacesRuntime,
            },
      } as never,
      WorktreeModeSelect,
    ))
}
