import type { InvokeArgs, InvokeOptions } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'

export function useInvoke<T>(channel: string, args?: InvokeArgs | undefined, options?: InvokeOptions): T | null {
  const [result, setResult] = useState<T | null>(null)

  useEffect(() => {
    let cancelled = false

    invoke(channel, args, options).then((response) => {
      if (!cancelled)
        setResult(response as T)
    })

    return () => {
      cancelled = true
    }
  }, [channel, args, options])

  return result
}
