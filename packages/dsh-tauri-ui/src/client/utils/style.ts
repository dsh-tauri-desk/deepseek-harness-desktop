import type { CNode } from 'css-render'

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
