import type { CNode } from 'css-render'
import { useEffect, useRef } from 'react'
import { mountStyle } from '../utils/style'

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
