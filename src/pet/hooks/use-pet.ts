import type { RefObject } from 'react'
import { useRef } from 'react'

export const PET_STATUSES = [
  'idle',
  'turn',
  'moving-left',
  'moving-right',
  'waving',
  'waiting',
  'running',
  'review',
  'failed',
] as const

export type PetStatus = (typeof PET_STATUSES)[number]

export interface PetChangeOptions {
  loop?: boolean
  status: PetStatus
}

export interface PetHandle {
  change: (options: PetChangeOptions) => void
  clear: () => void
  readonly status: PetStatus
}

/**
 * 提供桌宠的命令面。组件内部通过同一个 ref 暴露真正的播放器，调用方不接触
 * 资源、Codex 精灵图或动画结束事件；ref 命令优先于 status 属性。
 */
export function usePet(petRef?: RefObject<PetHandle | null>): PetHandle {
  const handleRef = useRef<PetHandle | null>(null)
  if (handleRef.current === null) {
    handleRef.current = {
      change(options) {
        petRef?.current?.change(options)
      },
      clear() {
        petRef?.current?.clear()
      },
      get status() {
        return petRef?.current?.status ?? 'idle'
      },
    }
  }
  return handleRef.current
}
