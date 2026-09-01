/**
 * components/conversation-seat.tsx — conversation 槽条目：包标记容器
 * + 宿主内容列（宽度约束由宿主决定，见 styles.ts）+ 内容宽度拖拽手柄（方案 A）。
 *
 * 宽度能力（镜像 alpha ConversationRoot）：
 *   - 根元素 ref + ResizeObserver 发布 `--dsh-conversation-column-width`；
 *   - 偏好读写（localStorage 与官方共用一键）；拖拽结束 commit 写回；
 *   - 左右对称 `data-width-handle` 手柄（pointer capture + rAF + 外向 2×）；
 *   - 无偏好时回退自适应 clamp；旧 WebView（无 RO/PointerEvent）→ 手柄不渲染、
 *     宽度固定（supported=false），见 service/width.ts。
 *
 * 纯展示组件；spec 由控制器在渲染期快照注入（close() 置空后条目已注销）。
 */

import type { ReactElement } from 'react'
import type { PanelWidthController } from '../service/width'
import type { PanelContentSpec } from '../types'
import { useEffect, useRef } from 'react'
import { PANEL_CLASSES, PANEL_DATA_ATTRIBUTES } from '../constants'
import { WidthHandle } from './width-handle'

export function ConversationSeat({
  t,
  spec,
  width,
}: {
  t: (key: string) => string
  spec: PanelContentSpec | undefined
  width: PanelWidthController
}): ReactElement | null {
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 挂载根元素到宽度控制器：RO 发布列宽 + 偏好；卸载时 detach（disconnect）。
  useEffect(() => {
    const root = rootRef.current
    if (!root)
      return undefined
    return width.attach(root)
  }, [width])

  if (!spec)
    return null
  const View = spec.render
  return (
    <div ref={rootRef} {...{ [PANEL_DATA_ATTRIBUTES.view]: '' }} className={PANEL_CLASSES.panelView}>
      {/* 内容列：对齐官方内容列宽度（max-width var(--dsh-chat-content-width, 780px)），
          子插件零宽度关注，只负责内容自身布局（垂直方向自定）。 */}
      <div style={{ padding: '16px 16px 16px 8px' }}>
        <div className={PANEL_CLASSES.panelViewColumn}>
          <View t={t} />
        </div>
      </div>
      {/* 面板打开即视为 active：渲染左右手柄（能力缺失时 supported=false 不渲染）。 */}
      {width.supported && (
        <>
          <WidthHandle side="left" handle={width.handle} />
          <WidthHandle side="right" handle={width.handle} />
        </>
      )}
    </div>
  )
}
