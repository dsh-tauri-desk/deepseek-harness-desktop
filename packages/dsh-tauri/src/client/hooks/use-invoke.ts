import type { InvokeArgs, InvokeOptions } from '../types'
import { useEffect, useRef, useState } from 'react'
import { invoke } from '../service/invoke'

export interface UseInvokeResult<T> {
  /** command 成功返回值；未完成/失败时为 null。 */
  data: T | null
  loading: boolean
  /** 失败原因（`NODE_NOT_ANSWERED: …` / command 抛出的字符串）；成功时为 null。 */
  error: string | null
}

/**
 * 调用一次宿主侧 Tauri command 并把结果交给组件（`invoke` 的 React 版）。
 *
 * 只做「读一次」：`cmd`（或 `args` 的内容）变化时重新调用，卸载后丢弃结果。
 * 变更类调用（写设置、触发动作）请在事件回调里直接 `invoke`，不要用本 hook。
 *
 * 参数与依赖：
 * - `args` / `options` 经 ref 转发，**不**参与 effect 依赖（对象字面量每次渲染都是新引用，
 *   直接用引用做依赖会每帧重发请求并自我循环）；重发条件按 `args` 的 JSON 串判断，
 *   因此 `args` 必须是可结构化克隆的普通数据（桥的既有约束）；
 * - 失败不静默：登记到 `error`，调用方决定展示方式（同时 console 一条便于排查）。
 *
 * @example
 * const { data: pets, loading } = useInvoke<PetListItem[]>('list_pets', { source: 'chat' })
 */
export function useInvoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): UseInvokeResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const argsRef = useRef(args)
  const optionsRef = useRef(options)
  argsRef.current = args
  optionsRef.current = options

  // 重发键：cmd + args 内容（同一内容的新对象不重发）
  const argsKey = args === undefined ? '' : JSON.stringify(args)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    invoke<T>(cmd, argsRef.current, optionsRef.current)
      .then((value) => {
        if (cancelled)
          return
        setData(value)
      })
      .catch((reason: unknown) => {
        if (cancelled)
          return
        const message = reason instanceof Error ? reason.message : String(reason)
        console.error(`[useInvoke] ${cmd} failed:`, reason)
        setError(message)
      })
      .finally(() => {
        if (!cancelled)
          setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // argsKey 是 args 的归一化依赖；args/options 本体经 ref 读取
  }, [cmd, argsKey])

  return { data, loading, error }
}
