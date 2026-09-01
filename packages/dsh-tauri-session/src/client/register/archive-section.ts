/**
 * register/archive-section.ts — 设置页「归档」分区的 slot 注册。
 *
 * 注册进 settings.section（导航行/内容由官方设置侧边栏投影）；effect 生命周期
 * 内清理 inject 句柄。alpha 要求注册进入前槽已由父条目 children 表声明。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { ArchivePanel } from '../components/archive-panel'
import {
  SESSION_ARCHIVE_SECTION_EFFECT,
  SESSION_REGISTRANT,
  SESSION_SECTION_ID,
  SESSION_SECTION_ORDER,
  SETTINGS_SECTION_SLOT,
} from '../constants'
import { text } from '../locales'

export function registerArchiveSection(ctx: ClientContext): void {
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
            inject: () => ({ sessionsRuntime: ctx.sessions, workspacesRuntime: ctx.workspaces }),
          } as never,
          ArchivePanel,
        )),
    SESSION_ARCHIVE_SECTION_EFFECT,
  )
}
