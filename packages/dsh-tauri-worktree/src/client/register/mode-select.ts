/**
 * register/mode-select.ts — 「标准模式」右侧工作模式选择器的 slot 注册。
 *
 * 注册进 conversation.input.dock；inject 句柄随 effect 生命周期释放。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionsRuntime } from '../types'
import { compat } from 'dsh-tauri/client'
import { WorktreeModeSelect } from '../components/mode-select'
import { INPUT_DOCK_SLOT, MODE_SELECT_ID, MODE_SELECT_ORDER } from '../constants'
import { NS } from '../locales'

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
        inject: (sessionId: string | undefined) => sessionId === undefined
          ? undefined
          : { sessionId, sessionsRuntime: cx.sessions as unknown as SessionsRuntime },
      } as never,
      WorktreeModeSelect,
    ))
}
