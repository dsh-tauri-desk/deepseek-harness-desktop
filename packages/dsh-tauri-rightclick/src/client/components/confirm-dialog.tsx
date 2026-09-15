import type { ConfirmDialogOptions } from './confirm-dialog.types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createRoot } from 'react-dom/client'
import { locale } from '../locales'

/**
 * 客户端样式确认框：确认 resolve(true)，取消 / 关闭 resolve(false)。
 * 内嵌 WebView2 的原生 confirm 会以嵌入页横幅出现且不随主题，这里用 primitives Modal 渲染。
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
    root.render(
      <Modal
        open
        onClose={() => close(false)}
        closeLabel={locale.text('close')}
        title={options.title}
        description={options.description}
        footer={(
          <div>
            <Button variant="ghost" style={{ marginRight: 6 }} onClick={() => close(false)}>
              {locale.text('cancel')}
            </Button>
            <Button variant="outline" onClick={() => close(true)}>
              {options.confirmLabel}
            </Button>
          </div>
        )}
      />,
    )
  })
}
