import type { ReactNode } from 'react'
import type { ToastUpdateEvent } from '@/config/hooks'
import { Spinner, Toast } from '@heroui/react'
import { useListener } from '@reause/core'
import { useState } from 'react'
import { If } from 'react-if-lite'
import { hooks } from '@/config/hooks'
import { activeQueues, placements } from '@/utils/toast'

interface ToastProviderProps {
  children?: ReactNode
  custom?: boolean
}

/**
 * 应用共用的 HeroUI queue/provider。桌宠窗口通过 custom 渲染精简气泡，
 * 主窗口保留 HeroUI 默认的操作和关闭按钮。
 */
export function ToastProvider(props: ToastProviderProps) {
  const [updates, setUpdates] = useState(() => new Map<string, ToastUpdateEvent['options']>())

  // 订阅 toast 原地更新事件；useListener 负责在卸载时注销
  useListener(hooks['toast.updated'].on, (event) => {
    if (event === undefined || typeof event.key !== 'string')
      return
    setUpdates((current) => {
      const next = new Map(current)
      next.set(event.key, { ...(current.get(event.key) ?? {}), ...event.options })
      return next
    })
  })

  return (
    <>
      {placements.map(placement => (
        <Toast.Provider
          key={placement}
          placement={placement}
          queue={activeQueues[placement]}
          className="[&_[data-frontmost=true]_[data-slot=toast-close]]:pointer-events-auto [&_[data-frontmost=true]_[data-slot=toast-close]]:opacity-100"
        >
          {props.custom
            ? ({ toast: item }) => {
                const content = { ...item.content, ...updates.get(item.key) }
                return (
                  <Toast toast={item} variant={content?.variant}>
                    <If cond={content?.isLoading} else={<Toast.Indicator variant={content?.variant} />}>
                      <Toast.Indicator variant={content?.variant}>
                        <Spinner color="current" size="sm" />
                      </Toast.Indicator>
                    </If>
                    <Toast.Content className="overflow-hidden">
                      <If cond={content?.title !== undefined}>
                        <Toast.Title>{content?.title}</Toast.Title>
                      </If>
                      <If cond={content?.description !== undefined}>
                        <Toast.Description className="line-clamp-2">
                          {content?.description}
                        </Toast.Description>
                      </If>
                    </Toast.Content>
                  </Toast>
                )
              }
            : null}
        </Toast.Provider>
      ))}
      {props.children}
    </>
  )
}
