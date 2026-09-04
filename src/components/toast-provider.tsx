import type { ReactNode } from 'react'
import { Toast } from '@heroui/react'
import { If } from 'react-if-lite'
import { placements, queues } from '@/utils/toast'

interface ToastProviderProps {
  children?: ReactNode
  hideCloseButton?: boolean
}

/**
 * 应用共用的 HeroUI queue/provider。桌宠窗口仅通过 hideCloseButton 使用
 * 自定义渲染分支，仍复用这里的 queues 与 src/utils/toast.ts API。
 */
export function ToastProvider(props: ToastProviderProps) {
  return (
    <>
      {placements.map(placement => (
        <Toast.Provider
          key={placement}
          placement={placement}
          queue={queues[placement]}
        >
          {props.hideCloseButton
            ? ({ toast: item }) => {
                const content = item.content
                return (
                  <Toast toast={item} variant={content?.variant}>
                    <Toast.Content>
                      <If cond={content?.title !== undefined}>
                        <Toast.Title>{content?.title}</Toast.Title>
                      </If>
                      <If cond={content?.description !== undefined}>
                        <Toast.Description>{content?.description}</Toast.Description>
                      </If>
                    </Toast.Content>
                  </Toast>
                )
              }
            : undefined}
        </Toast.Provider>
      ))}
      {props.children}
    </>
  )
}
