/**
 * client/controller.ts — 基于 hookable 的生命周期控制器（全 workspace 客户端共享）。
 *
 * Controller 化统一方案：observer / timer / listener / disposer 全部登记进一个
 * 受控对象（dispose 为命名 hook），卸载时一次性清理；dispose 幂等，异步续接以
 * isDisposed() 守护，业务代码无需各自维护 disposed 标志。
 *
 * 用 hookable 而非自写 Set：生命周期即「命名钩子」轴（dispose），并保留向
 * 'dispose' 之外扩展命名钩子的余地（宿主钩子同理，见各插件 host/hooks.ts）。
 */

import { createHooks } from 'hookable'

/** 控制器注册的命名生命周期钩子（dispose 为统一清理点）。 */
export interface LifecycleHooks {
  dispose: () => void
}

/** 受控生命周期资源（listener / timer / observer / disposer）的统一归口。 */
export interface LifecycleController {
  /** 注册任意 disposer（dispose 时统一执行；执行失败不中断其他清理）。 */
  add: (disposer: () => void) => void
  /** 受控 setTimeout：dispose 后不再触发；返回提前取消句柄。 */
  timeout: (fn: () => void, ms: number) => () => void
  /** 受控 setInterval：dispose 时自动清除；返回提前取消句柄。 */
  interval: (fn: () => void, ms: number) => () => void
  /** 受控 document 事件监听：dispose 时自动移除；返回移除句柄。 */
  listen: <K extends keyof DocumentEventMap>(
    type: K,
    fn: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => () => void
  /** 受控 MutationObserver：dispose 时自动 disconnect；返回 observer 本体。 */
  observe: (target: Node, options: MutationObserverInit, onMutate: () => void) => MutationObserver
  /** 是否已 dispose（异步续接的 guard 用）。 */
  isDisposed: () => boolean
  /** 一次性清理所有已注册资源（幂等）。 */
  dispose: () => void
}

/** 创建生命周期控制器（hookable hooks + 资源登记）。 */
export function createLifecycleController(): LifecycleController {
  const hooks = createHooks<LifecycleHooks>()
  let disposedState = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const intervals = new Set<ReturnType<typeof setInterval>>()
  const observers = new Set<MutationObserver>()
  const removes = new Set<() => void>()

  const api: LifecycleController = {
    add(disposer) {
      if (disposedState)
        return
      hooks.hook('dispose', disposer)
    },
    timeout(fn, ms) {
      if (disposedState)
        return () => {}
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!disposedState)
          fn()
      }, ms)
      timers.add(timer)
      return () => {
        timers.delete(timer)
        clearTimeout(timer)
      }
    },
    interval(fn, ms) {
      if (disposedState)
        return () => {}
      const timer = setInterval(() => {
        if (!disposedState)
          fn()
      }, ms)
      intervals.add(timer)
      return () => {
        intervals.delete(timer)
        clearInterval(timer)
      }
    },
    listen(type, fn, options = {}) {
      const handler = fn as EventListener
      document.addEventListener(type, handler, options)
      const remove = () => {
        document.removeEventListener(type, handler, options)
        removes.delete(remove)
      }
      removes.add(remove)
      return remove
    },
    observe(target, options, onMutate) {
      const observer = new MutationObserver(() => {
        if (!disposedState)
          onMutate()
      })
      observer.observe(target, options)
      observers.add(observer)
      return observer
    },
    isDisposed() {
      return disposedState
    },
    dispose() {
      if (disposedState)
        return
      disposedState = true
      for (const timer of timers)
        clearTimeout(timer)
      timers.clear()
      for (const timer of intervals)
        clearInterval(timer)
      intervals.clear()
      for (const observer of observers)
        observer.disconnect()
      observers.clear()
      for (const remove of removes) {
        try {
          remove()
        }
        catch {
          /* 监听已由目标主动移除时忽略 */
        }
      }
      removes.clear()
      // disposer 统一走命名 hook（同步执行；hookable 返回的 promise 不阻塞清理）。
      void hooks.callHook('dispose')
      hooks.removeAllHooks()
    },
  }
  return api
}
