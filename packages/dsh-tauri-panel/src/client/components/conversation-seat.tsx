/**
 * components/conversation-seat.tsx — conversation 槽条目：包标记容器
 * + 宿主内容列（宽度约束由宿主决定，见 styles.ts）。
 *
 * 纯展示组件；spec 由控制器在渲染期快照注入（close() 置空后条目已注销）。
 */

import type { ReactElement } from 'react'
import type { PanelContentSpec } from '../types'
import { PANEL_CLASSES, PANEL_DATA_ATTRIBUTES } from '../constants'

export function ConversationSeat({ t, spec }: { t: (key: string) => string, spec: PanelContentSpec | undefined }): ReactElement | null {
  if (!spec)
    return null
  const View = spec.render
  return (
    <div {...{ [PANEL_DATA_ATTRIBUTES.view]: '' }} className={PANEL_CLASSES.panelView}>
      {/* 内容列：对齐官方内容列宽度（max-width var(--dsh-chat-content-width, 748px)），
          子插件零宽度关注，只负责内容自身布局（垂直方向自定）。 */}
      <div style={{ padding: '16px 16px 16px 8px' }}>
        <div className={PANEL_CLASSES.panelViewColumn}>
          <View t={t} />
        </div>
      </div>
    </div>
  )
}
