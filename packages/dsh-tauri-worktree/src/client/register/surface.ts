/**
 * register/surface.ts — 工作树状态条（input.dock 上方的 surface）的 slot 注册。
 */

import type { Context } from '@deepseek-ai/cordis'
import { WorktreeSurface } from '../components/surface'
import { INPUT_DOCK_SLOT, SURFACE_ID, SURFACE_ORDER } from '../constants'

/** input.dock 正位于 inputBar 上方，宽度天然受右侧会话内容区约束。 */
export function registerSurface(ctx: Context): () => void {
  return ctx.slots.inject(INPUT_DOCK_SLOT as never, () =>
    ctx.slots.register(
      {
        name: INPUT_DOCK_SLOT,
        id: SURFACE_ID,
        order: SURFACE_ORDER,
        inject: (sessionId: string | undefined) => sessionId === undefined ? undefined : { sessionId },
      } as never,
      WorktreeSurface,
    ))
}
