import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { ArchivePanel } from '../components/archive-panel'
import {
  SESSION_REGISTRANT,
  SESSION_SECTION_ID,
  SESSION_SECTION_ORDER,
  SETTINGS_SECTION_SLOT,
} from '../constants'
import { locale } from '../locales'

/**
 * 设置页「归档」分区（导航行/内容由官方设置侧边栏投影）。
 * 会话/工作区运行时面取自 `adapter`（跨核心版本的服务布局差异由适配层收敛）。
 */
export const archiveSectionFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  controller.add(
    ctx.slots.inject(SETTINGS_SECTION_SLOT as never, () =>
      ctx.slots.register(
        {
          name: SETTINGS_SECTION_SLOT,
          id: SESSION_SECTION_ID,
          order: SESSION_SECTION_ORDER,
          registrant: SESSION_REGISTRANT,
          label: () => locale.text('section'),
          inject: () => ({
            sessionsRuntime: adapter.sessions,
            workspacesRuntime: adapter.workspaces,
          }),
        } as never,
        ArchivePanel,
      )),
  )
})
