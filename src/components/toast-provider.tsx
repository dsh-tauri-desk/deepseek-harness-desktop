import type { ReactNode } from 'react'
import type { ToastClearEvent, ToastCloseEvent, ToastUpdateEvent } from '@/utils/toast'
import { useEventBus } from '@hairy/react-lib'
import { Spinner, Toast } from '@heroui/react'
import { useState } from 'react'
import { If } from 'react-if-lite'
import { activeQueues, placements, TOAST_CLEAR_EVENT, TOAST_CLOSE_EVENT } from '@/utils/toast'

interface ToastProviderProps {
  children?: ReactNode
  hideCloseButton?: boolean
}

/**
 * 应用共用的 HeroUI queue/provider。桌宠窗口仅通过 hideCloseButton 使用
 * 自定义渲染分支，仍复用这里的 queues 与 src/utils/toast.ts API。
 */
export function ToastProvider(props: ToastProviderProps) {
  const [updates, setUpdates] = useState(() => new Map<string, ToastUpdateEvent['options']>())

  useEventBus<ToastUpdateEvent>('toast.update').on((event) => {
    if (event === undefined || typeof event.key !== 'string')
      return
    setUpdates((current) => {
      const next = new Map(current)
      next.set(event.key, { ...(current.get(event.key) ?? {}), ...event.options })
      return next
    })
  })

  // toast.close / 超时自动关闭 / toast.clear 后从 updates 摘除 key，
  // 避免 key 残留到 provider 卸载（旧 toast 重开 / 无界内存增长）。
  useEventBus<ToastCloseEvent>(TOAST_CLOSE_EVENT).on((event) => {
    if (event === undefined || typeof event.key !== 'string')
      return
    setUpdates((current) => {
      if (!current.has(event.key))
        return current
      const next = new Map(current)
      next.delete(event.key)
      return next
    })
  })
  useEventBus<ToastClearEvent>(TOAST_CLEAR_EVENT).on(() => {
    setUpdates(new Map())
  })

  return (
    <>
      {placements.map(placement => (
        <Toast.Provider
          key={placement}
          placement={placement}
          queue={activeQueues[placement]}
        >
          {props.hideCloseButton
            ? ({ toast: item }) => {
                const content = { ...item.content, ...updates.get(item.key) }

                // 对齐 HeroUI 默认渲染（getDefaultChildren）：indicator === null
                // 隐藏图标；isLoading 时显示 Spinner；否则显示内容或按 variant 的
                // 默认图标（default/accent→Info、success→Success、warning→Warning、
                // danger→Danger）。
                return (
                  <Toast toast={item} variant={content?.variant}>
                    <If cond={content?.isLoading} else={<Toast.Indicator variant={content?.variant} />}>
                      <Toast.Indicator variant={content?.variant}>
                        <Spinner color="current" size="sm" />
                      </Toast.Indicator>
                    </If>
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
