/**
 * confirm-dialog.ts — 客户端样式确认弹窗（primitives Modal），替代原生 confirm。
 *
 * 内嵌 WebView2 里的 `window.confirm` 会以「127.0.0.1:3080 嵌入页提示」横幅出现，
 * 不随客户端 UI 主题（#235）。这里用与官方一致的 primitives Modal 渲染，
 * Promise 化以便 await；仅依赖宿主提供的 react / primitives。
 */
import type { ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { text } from './locale'

/** 确认弹窗内容（标题 / 描述 / 确认按钮文案）。 */
export interface ConfirmDialogOptions {
  title: string
  description: string
  confirmLabel: string
}

/**
 * 打开客户端样式确认框：确认 resolve(true)，取消 / 关闭 resolve(false)。
 * 弹窗挂到 document.body 的临时宿主，关闭后卸载并移除。
 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (typeof document === 'undefined')
    return Promise.resolve(false)
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const close = (result: boolean): void => {
      root.unmount()
      host.remove()
      resolve(result)
    }
    const footer: ReactElement = createElement(
      'div',
      {},
      createElement(Button, { variant: 'ghost', onClick: () => close(false), style: { marginRight: 6 } }, text('cancel')),
      createElement(Button, { variant: 'outline', onClick: () => close(true) }, options.confirmLabel),
    )
    root.render(createElement(Modal, {
      open: true,
      onClose: () => close(false),
      title: options.title,
      description: options.description,
      footer,
    }))
  })
}
