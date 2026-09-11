import type { CNode } from 'css-render'
import { useEffect, useRef } from 'react'

/**
 * 命令式挂载 css-render 节点；返回卸载 disposer。
 *
 * 统一挂载路线：
 *   - 组件：useMountStyle(cnode, id)
 *   - Controller / ctx.effect：mountStyle(cnode, id)（由调用方把 disposer
 *     交给 controller.add 或 ctx.effect 返回）
 * 幂等：同一 CNode 实例多挂载只生效一次；引用计数保证最后一位持有者
 * 卸载时才真正 unmount。
 */
const mountCounts = new Map<CNode, number>()

export function mountStyle(cnode: CNode, id?: string): () => void {
  const release = (): void => {
    const next = (mountCounts.get(cnode) ?? 1) - 1
    if (next <= 0) {
      mountCounts.delete(cnode)
      cnode.unmount({ id })
    }
    else {
      mountCounts.set(cnode, next)
    }
  }
  if (typeof document === 'undefined')
    return () => {}
  const count = mountCounts.get(cnode) ?? 0
  if (count === 0)
    cnode.mount({ id, head: true })
  mountCounts.set(cnode, count + 1)
  return release
}

/** React hook：组件挂载时自动挂载、卸载时自动卸载。 */
export function useMountStyle(cnode: CNode, id?: string): void {
  const disposerRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    disposerRef.current = mountStyle(cnode, id)
    return () => {
      disposerRef.current?.()
      disposerRef.current = null
    }
  }, [cnode, id])
}
