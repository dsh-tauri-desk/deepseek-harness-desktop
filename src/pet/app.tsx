import type { DragDirection } from './hooks/use-drag'
import type { PetHandle, PetStatus } from './hooks/use-pet'
import { useWatch } from '@hairy/react-lib'
import { useRef } from 'react'
import { ToastProvider } from '@/components/toast-provider'
import { Pet } from './components/pet'
import { isLoopingAnimation } from './config'
import { useBubble } from './hooks/use-bubble'
import { useDrag } from './hooks/use-drag'
import { useOmitIgnoreCursorEvents } from './hooks/use-omit-ignore-cursor-events'
import { usePet } from './hooks/use-pet'

/** 拖拽方向 → 动画状态：桌面宠物在原生拖拽期间播放对应的移动动画。 */
const DRAW_STATUS: Record<DragDirection, PetStatus> = {
  left: 'moving-left',
  right: 'moving-right',
}

/** 桌宠窗口的唯一组合入口：只把会话状态映射到公开的 Pet 命令面。 */
export function App() {
  const petRef = useRef<PetHandle>(null)
  const pet = usePet(petRef)
  const bubble = useBubble()
  const dragRef = useRef<HTMLDivElement>(null)
  const { clickCount, direction, dragging } = useDrag(dragRef)
  useOmitIgnoreCursorEvents(dragRef)
  const drawStatus = direction === undefined ? undefined : DRAW_STATUS[direction]
  // 会话状态未变化时跳过下发：同一档位的重复命令不应重启动画。视频层还有第二层
  // 按「动画目标（资源 + 循环语义 + 重播序号）」的去重（pet.tsx → shouldReloadAnimation），
  // 即使不同档位解析到同一个动画也不会重新播放。
  const lastStatusRef = useRef<PetStatus | undefined>(undefined)

  useWatch(
    [bubble.status, pet],
    () => {
      if (bubble.status === lastStatusRef.current)
        return
      lastStatusRef.current = bubble.status
      if (bubble.status === undefined)
        return pet.clear()
      // 细分档位（thinking/working/result/waiting）与 running 均为循环档；
      // 终态档（success/error）与 review/failed 播一次后回落（handleEnded）。
      pet.change({
        loop: isLoopingAnimation(bubble.status),
        status: bubble.status,
      })
    },
  )

  return (
    <ToastProvider custom>
      {/* 外层只负责铺满透明窗口，保持 pointer-events-none；dragRef 绑定到 Pet 内部
          与 dsh-pet .dsh-pet-hit 一致的唯一可交互命中区。useDrag 负责拖拽/双击，
          useOmitIgnoreCursorEvents 负责穿透恢复，调用方无需管理鼠标流和窗口几何。 */}
      <div className="pointer-events-none h-full w-full touch-none select-none">
        <Pet
          status={drawStatus}
          dragging={dragging}
          clickCount={clickCount}
          hitboxRef={dragRef}
          ref={petRef}
        />
      </div>
    </ToastProvider>
  )
}
