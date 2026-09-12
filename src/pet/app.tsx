import type { PetRef, PetRenderMotion } from 'dsh-pet-component'
import { useEventListener, useWakeLock, useWatch } from '@reause/core'
import { Pet } from 'dsh-pet-component'
import { useRef } from 'react'
import { If } from 'react-if-lite'
import { ToastProvider } from '@/components/toast-provider'
import { useOmitIgnoreCursorEvents } from '@/hooks/use-omit-ignore-cursor-events'
import { useWindowDraggable } from '@/hooks/use-window-draggable'
import { Hint } from '@/ui/pet/hint'
import { PET_BASE_WIDTH, PET_DSH_ASPECT } from './constants'
import { useBubble } from './hooks/use-bubble'
import { usePetSource } from './hooks/use-pet-source'
import { normalizeSizePercent, usePetStatus } from './hooks/use-pet-status'
import { usePetWindowSize } from './hooks/use-pet-window'

/**
 * 桌宠窗口的唯一组合入口。
 *
 * 三条输入各管一段，互不越界：
 * - 设置状态（`usePetStatus`）→ 选哪个宠物、多大、是否可见；
 * - 会话气泡（`useBubble`）→ 聚合出的动作档位；
 * - 手势（`useWindowDraggable`）→ 拖动期间的方向动作。
 *
 * 动作全部经 `pet.motion(...)` / `pet.clear()` 下发到 `<Pet>` 的命令面（优先级高于
 * 声明式 `motion` prop），渲染细节（动画池解析、双视频缓冲、雪碧图、缓存、双击回应）
 * 由 `dsh-pet-component` 接管。
 */
export function App() {
  const petRef = useRef<PetRef>(null)
  const status = usePetStatus()

  // issue #469：桌宠动画是常驻播放的 <video>，Chromium 会因此持有 Video Wake Lock
  // 让系统无法息屏；本窗口没有常亮的正当需求，唤醒锁一旦生效就立刻释放。
  const wakelock = useWakeLock()
  useWatch(wakelock.isActive, () => {
    void wakelock.release()
  }, { immediate: true })

  const activePet = status?.active_pet ?? ''
  const { source, error } = usePetSource(activePet)
  const hitboxRef = useRef<HTMLDivElement>(null)
  const bubble = useBubble()
  const { dragging, direction } = useWindowDraggable()

  const visible = status === null || (status.enabled !== false && status.visible !== false)
  const width = (source?.width ?? PET_BASE_WIDTH) * normalizeSizePercent(status?.pet_size) / 100
  usePetWindowSize(width, source?.aspect ?? PET_DSH_ASPECT, visible)
  useOmitIgnoreCursorEvents(hitboxRef)
  // 桌宠窗口是装饰性的透明置顶小窗：右键不应弹出 WebView 默认 context menu。
  useEventListener('contextmenu', (event: Event) => event.preventDefault())

  // 手势优先于会话档位：拖动期间按方向播走路动画（dsh-pet 渲染器内部强制走 drag 池，
  // 会忽略这里的方向，由组件保证）；拖动结束或方向停摆后自动回落到会话档位。
  const motion: PetRenderMotion | undefined = dragging
    ? (direction === undefined ? undefined : `moving-${direction}`)
    : bubble.motion

  return (
    <ToastProvider custom>
      {/* 外层只负责铺满透明窗口并让宠物锚定底部居中；窗口内可交互面只有命中箱，
          其余区域由 useOmitIgnoreCursorEvents 按命中箱矩形整体穿透。 */}
      <main className={`pointer-events-none fixed inset-0 flex items-end justify-center ${visible ? '' : 'invisible'}`}>
        {source && (
          <Pet
            ref={petRef}
            kind={source.kind}
            config={source.config}
            uri={source.uri}
            ext={source.ext}
            motion={motion}
            size={width}
            dragging={dragging}
            cache={true}
            hidden={!visible}
            hitboxRef={hitboxRef}
          />
        )}
        {/* 选中了宠物但资源解析不出来（导入的宠物被删除、清单里没有该 id）：必须给出
            可见提示 —— 透明窗口里「空」与「在加载」观感相同，静默留空等于让用户以为坏了。 */}
        <If cond={error !== null} then={<Hint petId={activePet} />} />
      </main>
    </ToastProvider>
  )
}
