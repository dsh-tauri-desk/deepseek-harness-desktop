import type { DragDirection } from './hooks/use-drag'
import type { PetHandle, PetStatus } from './hooks/use-pet'
import { useWatch } from '@hairy/react-lib'
import { useRef } from 'react'
import { ToastProvider } from '@/components/toast-provider'
import { Pet } from './components/pet'
import { useBubble } from './hooks/use-bubble'
import { useDrag } from './hooks/use-drag'
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
  const drawStatus = direction === undefined ? undefined : DRAW_STATUS[direction]

  useWatch(
    [bubble.status, pet],
    () => {
      if (bubble.status === undefined)
        return pet.clear()
      pet.change({
        loop: bubble.status === 'running',
        status: bubble.status,
      })
    },
  )

  return (
    <ToastProvider hideCloseButton>
      {/* pointer-events-none：原生拖拽面只在宠物本体（pet 内层 pointer-events-auto）上生效，
          透明空白区点击保持惰性（事件经宠物节点冒泡到 dragRef 触发拖拽）。
          点击回应不依赖 DOM click/dblclick：Windows 原生拖拽会吞掉 pointerup，
          事件不合成——由 useDrag 按「两次按下间隔 < 500ms 且未拖拽」判定双击并用
          clickCount 上报；单击/拖拽结束均不触发。 */}
      <div
        ref={dragRef}
        className="pointer-events-none h-full w-full touch-none select-none"
      >
        <Pet status={drawStatus} dragging={dragging} clickCount={clickCount} ref={petRef} />
      </div>
    </ToastProvider>
  )
}
