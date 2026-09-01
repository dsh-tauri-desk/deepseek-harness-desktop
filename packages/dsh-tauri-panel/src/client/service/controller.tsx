/**
 * service/controller.tsx — 会话区替换控制器：拥有 inject 句柄、当前规格与
 * capture 层 pointerdown 监听；close() 恢复官方会话界面并释放全部资源。
 *
 * open/close 走命名钩子（hookable），供诊断与第三方联动。重复创建（插件
 * 重载）时旧实例先被其 effect 清理，互不干扰。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type { PanelContentSpec } from '../types'
import type { PanelWidthController } from './width'
import { createHooks } from 'dsh-tauri/client'
import { ConversationSeat } from '../components/conversation-seat'
import { PANEL_VIEW_COMPONENT_ID, PANEL_VIEW_SLOT } from '../constants'
import { setSidebarPanelActive, shouldClosePanelForSidebarTarget } from '../dom/panel'
import { NS } from '../locales'
import { panelViewStore } from '../store'
import { createPanelWidthController } from './width'

/** 会话区替换控制器的对外形状（panel.protocol 的机制侧）。 */
export interface PanelConversationController {
  open: (ctx: Context, spec: PanelContentSpec) => void
  close: () => void
  toggle: (ctx: Context, spec: PanelContentSpec) => void
  viewId: () => { id: string } | null
  /** 内容宽度控制器（方案 A：attach/handle；方案 C：setWidth/resetWidth/getWidth）。 */
  width: PanelWidthController
}

/** 会话区替换的生命周期钩子（hookable：open/close 事件轴）。 */
export interface ConversationLifecycleHooks {
  'view:open': (spec: PanelContentSpec) => void
  'view:close': () => void
}

/** 创建会话区替换控制器。 */
export function createPanelConversationController(): PanelConversationController {
  const hooks = createHooks<ConversationLifecycleHooks>()
  const width = createPanelWidthController()
  let conversationSeat: (() => void) | undefined
  let currentSpec: PanelContentSpec | undefined
  let onPointerDownCapture: ((event: PointerEvent) => void) | undefined

  /** 打开会话区替换：动态注册 priority -1 的 conversation 条目。 */
  function open(ctx: Context, spec: PanelContentSpec): void {
    if (currentSpec && currentSpec.id === spec.id)
      return
    if (conversationSeat)
      close()
    currentSpec = spec
    panelViewStore.set({ id: spec.id })
    conversationSeat = ctx.slots.inject(PANEL_VIEW_SLOT as never, () =>
      ctx.slots.register(
        {
          name: PANEL_VIEW_SLOT,
          id: PANEL_VIEW_COMPONENT_ID,
          priority: -1,
          locale: spec.locale ?? NS,
        } as never,
        // spec 经渲染期快照传入：close() 置空后条目已注销，组件自然卸载。
        (props: { t: (key: string) => string }): ReactElement => <ConversationSeat t={props.t} spec={currentSpec} width={width} />,
      ))
    onPointerDownCapture = (event: PointerEvent): void => {
      if (shouldClosePanelForSidebarTarget(event.target instanceof Element ? event.target : null))
        close()
    }
    document.addEventListener('pointerdown', onPointerDownCapture, true)
    setSidebarPanelActive(true)
    void hooks.callHook('view:open', spec)
  }

  /** 关闭会话区替换：dispose inject 句柄 → 注销条目 → 官方 ui-conversation 恢复。 */
  function close(): void {
    conversationSeat?.()
    conversationSeat = undefined
    currentSpec = undefined
    panelViewStore.set(null)
    if (onPointerDownCapture) {
      document.removeEventListener('pointerdown', onPointerDownCapture, true)
      onPointerDownCapture = undefined
    }
    setSidebarPanelActive(false)
    void hooks.callHook('view:close')
  }

  return {
    open,
    close,
    toggle(ctx, spec) {
      if (currentSpec)
        close()
      else
        open(ctx, spec)
    },
    viewId: () => panelViewStore.getSnapshot(),
    width,
  }
}
