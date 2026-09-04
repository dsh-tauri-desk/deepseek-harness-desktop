import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { DragMachine, DragPhase } from './drag-machine'
import type {
  PetActivity,
  PetAnimation,
  PetFacing,
} from './state'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { cursorPosition, getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { useEffect, useRef, useState } from 'react'
import { If } from 'react-if-lite'
import { toast } from '@/utils/toast'
import { resolvePetActivity } from './arbiter'
import {
  beginDrag,
  createDragMachine,
  DRAG_SAMPLE_INTERVAL_MS,
  dragSample,
  endDrag,
  hasDragged,
  isDragActive,
  resetDrag,
} from './drag-machine'
import { SessionBubble } from './session-bubble'
import { sessionBubbleDescription, sessionBubbleStore, sessionBubbleTitle } from './session-bubbles'
import {
  getPetVisual,
  getSpriteFramePosition,
  getSpriteSequence,
  normalizePetActivity,
} from './state'
import { useEvent } from 'react-use'

interface PetStatus {
  enabled: boolean
  visible?: boolean | null
  active_pet?: string | null
  pet_size?: number | null
  activity?: unknown
  bubble?: unknown
  sessions?: Array<{ id: string, activity?: unknown, bubble?: unknown, description?: unknown }>
}

interface PetAsset {
  columns: number
  id: string
  rows: number
  sprite_version_number: number
  spritesheet: string
}

interface DragState {
  active: boolean
  nativeStarted: boolean
  pointerId: number
  requestId: number
}

interface Copy {
  petLabel: string
}

const BUILT_IN_PET_ID = 'maid-deepseek-whale'
const PET_DEFAULT_SIZE_PERCENT = 100
const PET_BASE_WIDTH = 220
const PET_STATUS_EVENT = 'pet://status'
const CLICK_DELAY_MS = 220

const COPY: Record<'en' | 'zh', Copy> = {
  en: {
    petLabel: 'DeepSeek Harness desktop pet',
  },
  zh: {
    petLabel: 'DeepSeek Harness 桌宠',
  },
}

type BuiltinAssetKey = 'idle' | 'turn' | 'move' | 'wave' | 'waiting' | 'running' | 'review' | 'failed' | 'bubble' | 'fallback'

/** 常驻预加载的 9 个内置视频键；fallback 走 <img> 降级路径，不占视频槽位。 */
type VideoKey = Exclude<BuiltinAssetKey, 'fallback'>
const VIDEO_KEYS: VideoKey[] = ['idle', 'turn', 'move', 'wave', 'waiting', 'running', 'review', 'failed', 'bubble']
/** 一次性动画结束后回到动作起点；循环动画暂停后原位续播。 */
const ONCE_KEYS = new Set<VideoKey>(['turn', 'wave', 'bubble'])

/** 独立透明桌宠窗口：事件驱动状态、内置视频、自定义精灵图与无积压拖拽。 */
export function PetWindow() {
  const [status, setStatus] = useState<PetStatus>({ enabled: false })
  const [builtinAssets, setBuiltinAssets] = useState<Record<string, string>>({})
  const [sessionActivity, setSessionActivity] = useState<PetActivity>('idle')
  const [localActivity, setLocalActivity] = useState<PetAnimation | null>(null)
  const [facing, setFacing] = useState<PetFacing>('left')
  const [failedPet, setFailedPet] = useState<string | null>(null)
  const [builtinAssetFailed, setBuiltinAssetFailed] = useState(false)
  const [fallbackFailed, setFallbackFailed] = useState(false)
  const [customAsset, setCustomAsset] = useState<PetAsset | null>(null)
  const [spriteAspect, setSpriteAspect] = useState<{ id: string, value: number } | null>(null)
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [dragPhase, setDragPhase] = useState<DragPhase>('idle')
  const clickTimerRef = useRef<number | null>(null)
  const activeVideoKeyRef = useRef<VideoKey | null>(null)
  const videoElementsRef = useRef<Record<VideoKey, HTMLVideoElement | null>>({ idle: null, turn: null, move: null, wave: null, waiting: null, running: null, review: null, failed: null, bubble: null })
  const spriteRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState>({ active: false, nativeStarted: false, pointerId: -1, requestId: 0 })
  const dragMachineRef = useRef<DragMachine>(createDragMachine())
  const dragRequestRef = useRef(0)
  const sessionToastKeysRef = useRef(new Map<string, string>())
  const sessionActivityRef = useRef<PetActivity>('idle')
  sessionActivityRef.current = sessionActivity
  // 拖动动画由 dragPhase（phase==='dragging'）+ facing 直接驱动；
  // 不再从 ref 在渲染期读取，避免 facing/localActivity 不变时不重渲染导致动画不播（root cause #3）。
  const draggingActivity = dragPhase === 'dragging'
    ? (facing === 'left' ? 'moving-left' : 'moving-right')
    : null
  const activity = resolvePetActivity({
    sessionActivity,
    draggingActivity,
    interactionActivity: localActivity,
  })
  const isWorkLocked = sessionActivity === 'waiting' || sessionActivity === 'running'
  const visual = getPetVisual(activity, facing)
  const whaleFallbackUrl = builtinAssetUrl('fallback', builtinAssets)
  const activePet = normalizeActivePet(status.active_pet)
  const usesCustomSprite = activePet !== BUILT_IN_PET_ID
  const visibleCustomAsset = customAsset?.id === activePet ? customAsset : null
  const mediaFailed = failedPet === activePet || builtinAssetFailed
  // 内置媒体池是否就绪：src 由 Rust 固定白名单映射，idle 到位即按 9 个常驻视频渲染。
  const videoPoolReady = !usesCustomSprite && !builtinAssetFailed && builtinAssets.idle !== undefined
  const activeVideoKey = assetKeyForVisual(visual.asset)
  const petSizePercent = normalizePetSize(status.pet_size)
  const copy = getCopy()
  const isVisible = status.enabled && status.visible !== false
  const petAspect = usesCustomSprite
    ? (spriteAspect?.id === activePet ? spriteAspect.value : 208 / 192)
    : 9 / 16
  const petStyle = {
    '--pet-width': `${(PET_BASE_WIDTH * petSizePercent) / 100}px`,
    '--pet-scale': String(petSizePercent / 100),
    '--pet-facing': usesCustomSprite || visual.facing === 'left' ? '1' : '-1',
    '--pet-aspect': usesCustomSprite && spriteAspect?.id === activePet ? spriteAspect.value : (usesCustomSprite ? 208 / 192 : 9 / 16),
  } as CSSProperties

  // 内置媒体清单由 Rust 固定白名单生成，避免前端注入插件目录路径。
  useEffect(() => {
    let cancelled = false
    void invoke<{ assets?: Record<string, string> }>('get_builtin_pet_assets').then((value) => {
      if (!cancelled && value.assets)
        setBuiltinAssets(value.assets)
      if (!cancelled && !value.assets?.idle)
        setBuiltinAssetFailed(true)
    }).catch((error) => {
      setBuiltinAssetFailed(true)
      console.error('[pet] PET_BUILTIN_ASSET_LOAD_FAILED:', error)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 初次读取一次持久化状态，随后完全依赖 pet://status 事件，不再轮询。
  useEffect(() => {
    let cancelled = false
    let dispose: (() => void) | undefined

    function applyStatus(nextStatus: PetStatus) {
      if (cancelled)
        return
      setStatus(nextStatus)
      syncSessionToasts(nextStatus)
      if (!nextStatus.enabled || nextStatus.visible === false)
        toast.clear()
      const nextActivity = normalizePetActivity(nextStatus.activity)
      setSessionActivity(nextActivity)
      if (nextActivity !== 'idle') {
        clearClickTimer()
        setLocalActivity(null)
      }
    }

    void (async () => {
      try {
        const unlisten = await listen<PetStatus>(PET_STATUS_EVENT, (event) => {
          applyStatus(event.payload)
        })
        if (cancelled)
          unlisten()
        else
          dispose = unlisten
        const initial = await invoke<PetStatus>('get_pet_status')
        applyStatus(initial)
      }
      catch (error) {
        console.error('[pet] PET_STATUS_CHANNEL_FAILED:', error)
      }
    })()

    return () => {
      cancelled = true
      dispose?.()
      clearSessionToasts()
    }
    // 仅在窗口首次挂载时建立事件通道；气泡函数通过 ref 定时器管理自身生命周期。
  }, [])

  // active_pet 使用来源限定 id；只有内置默认宠物继续走 WebM 状态机。
  useEffect(() => {
    let cancelled = false
    if (!usesCustomSprite)
      return undefined

    void invoke<PetAsset>('get_pet_asset', { id: activePet }).then((asset) => {
      if (cancelled)
        return
      if (!isSupportedAsset(asset))
        throw new Error('PET_ASSET_INVALID: expected Codex v2 8x11 spritesheet')
      setFailedPet(null)
      setCustomAsset(asset)
    }).catch((error) => {
      if (!cancelled) {
        setFailedPet(activePet)
        console.error('[pet] get_pet_asset failed:', error)
      }
    })

    return () => {
      cancelled = true
    }
  }, [activePet, usesCustomSprite])

  // 精灵图逐帧计时与参考实现一致，动作三轮后安全进入慢速 idle。
  useEffect(() => {
    const sprite = spriteRef.current
    if (!usesCustomSprite || visibleCustomAsset === null || sprite === null)
      return undefined
    const spriteElement = sprite
    const asset = visibleCustomAsset
    const sequence = getSpriteSequence(activity, facing, reducedMotion)
    let index = 0
    let timer: number | undefined

    function paint() {
      const current = sequence.frames[index]
      spriteElement.style.backgroundPosition = getSpriteFramePosition(current, asset.columns, asset.rows)
      spriteElement.dataset.petFrame = String(index)
      if (sequence.frames.length === 1)
        return
      timer = window.setTimeout(() => {
        const next = index + 1
        index = next >= sequence.frames.length ? (sequence.loopStart ?? index) : next
        paint()
      }, current.duration)
    }

    paint()
    return () => {
      if (timer !== undefined)
        window.clearTimeout(timer)
    }
  }, [activity, facing, reducedMotion, usesCustomSprite, visibleCustomAsset])

  // 一次性交互在精灵图中完整播放三轮后回到会话状态；turn 同时切换朝向。
  useEffect(() => {
    if (!usesCustomSprite || localActivity === null)
      return undefined
    const sequence = getSpriteSequence(localActivity, facing, reducedMotion)
    const actionLength = sequence.loopStart ?? sequence.frames.length
    const duration = sequence.frames.slice(0, actionLength).reduce((total, frame) => total + frame.duration, 0)
    const timer = window.setTimeout(() => {
      if (localActivity === 'turn')
        setFacing(current => current === 'left' ? 'right' : 'left')
      setLocalActivity(null)
    }, duration)
    return () => window.clearTimeout(timer)
  }, [facing, localActivity, reducedMotion, usesCustomSprite])

  // 拖动方向完全由窗口物理位置驱动（outerPosition 增量），与 WebView 指针事件无关。
  // 主来源 appWindow.onMoved；Windows 系统模态拖动期间该事件可能被吞掉，故按下后另起一个
  // 固定间隔轮询 outerPosition 的兜底，二者都喂给 dragSample 状态机。
  // dragPhase 驱动此 effect 建立/拆除兜底轮询；采样函数内联以规避 react-hooks 依赖提示。
  useEffect(() => {
    const appWindow = getCurrentWindow()
    let cancelled = false
    let disposeMoved: (() => void) | undefined

    function applyDragSample(x: number) {
      const machine = dragMachineRef.current
      const next = dragSample(machine, x)

      if (next === machine)
        return

      dragMachineRef.current = next
      if (next.phase !== machine.phase)
        setDragPhase(next.phase)
      if (next.facing !== machine.facing)
        setFacing(next.facing)
    }

    void appWindow.onMoved((event) => {
      if (!cancelled)
        applyDragSample(event.payload.x)
    }).then((unlisten) => {
      if (cancelled)
        unlisten()
      else
        disposeMoved = unlisten
    }).catch(() => {})

    let timer: number | null = null
    if (isDragActive(dragMachineRef.current)) {
      timer = window.setInterval(() => {
        void appWindow.outerPosition().then((position) => {
          if (!cancelled)
            applyDragSample(position.x)
        }).catch(() => {})
      }, DRAG_SAMPLE_INTERVAL_MS)
    }

    return () => {
      cancelled = true
      disposeMoved?.()
      if (timer !== null)
        window.clearInterval(timer)
    }
  }, [dragPhase])

  // 原生窗口尺寸跟随实际资源宽高；透明顶部只为 Toast 保留，不扩大宠物拖拽区。
  // 由前端按当前资源真实画布比例设置，避免与 Rust（只按图集默认比例）重复 set_size 打架。
  useEffect(() => {
    if (!status.enabled)
      return
    const appWindow = getCurrentWindow()
    const width = (PET_BASE_WIDTH * petSizePercent) / 100 + 32
    const height = (PET_BASE_WIDTH * petSizePercent) / 100 * petAspect + 82
    void appWindow.setSize(new LogicalSize(width, height)).then(() => {
      // 放大后把窗口夹回可见显示器，避免右侧/底部被推出屏幕；复用 Rust 的夹取逻辑。
      void invoke('move_pet_window', { deltaX: 0, deltaY: 0 }).catch(() => {})
    }).catch((error) => {
      console.warn('[pet] PET_WINDOW_RESIZE_FAILED:', error)
    })
  }, [petAspect, petSizePercent, status.enabled])

  // 透明窗口仍覆盖一个矩形；只有资源本身与 Toast 的真实 DOM 区域接收鼠标。
  // 使用全局物理光标坐标轮询，可在 setIgnoreCursorEvents(true) 后重新恢复可点击状态。
  useEffect(() => {
    const appWindow = getCurrentWindow()
    let cancelled = false
    let lastIgnore: boolean | undefined

    async function updateCursorMode() {
      if (cancelled || !status.enabled || status.visible === false)
        return
      try {
        const [cursor, origin, scale] = await Promise.all([
          cursorPosition(),
          appWindow.innerPosition(),
          appWindow.scaleFactor(),
        ])
        const anchor = document.querySelector<HTMLElement>('.pet-anchor')?.getBoundingClientRect()
        const toastRegions = [...document.querySelectorAll<HTMLElement>('[data-slot="toast-region"]')]
        const contains = (rect: DOMRect | undefined) => rect !== undefined
          && cursor.x >= origin.x + rect.left * scale
          && cursor.x <= origin.x + rect.right * scale
          && cursor.y >= origin.y + rect.top * scale
          && cursor.y <= origin.y + rect.bottom * scale
        const interactive = contains(anchor) || toastRegions.some(region => contains(region.getBoundingClientRect()))
        const ignore = !interactive
        if (ignore !== lastIgnore) {
          lastIgnore = ignore
          await appWindow.setIgnoreCursorEvents(ignore)
        }
      }
      catch {
        // 窗口销毁或系统暂时无法读取光标位置时不改变当前命中模式。
      }
    }

    void updateCursorMode()
    const timer = window.setInterval(() => {
      void updateCursorMode()
    }, 50)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      void appWindow.setIgnoreCursorEvents(false).catch(() => {})
    }
  }, [status.enabled, status.visible])

  // 跟随操作系统的降低动态效果偏好，自定义精灵图冻结在对应动作首帧。
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    function applyPreference() {
      setReducedMotion(query.matches)
    }
    query.addEventListener('change', applyPreference)
    return () => query.removeEventListener('change', applyPreference)
  }, [])

  // 常驻 9 个内置视频只激活一个：切出时暂停（一次性动画停回首帧），切入时回零后播放，
  // 其余视频保持预载与解码状态，不再重建 <video>，避免动作切换闪帧（issue #308）。
  useEffect(() => {
    if (!videoPoolReady)
      return undefined
    const elements = videoElementsRef.current
    const next = activeVideoKey
    const el = elements[next]
    if (!el || !el.src)
      return undefined
    const previous = activeVideoKeyRef.current
    if (previous !== null && previous !== next) {
      const oldPaused = elements[previous]
      if (oldPaused) {
        oldPaused.pause()
        if (ONCE_KEYS.has(previous))
          oldPaused.currentTime = 0
      }
    }
    activeVideoKeyRef.current = next
    // 激活的媒体真正开始播放时清除失败标记；后台视频的 playing 事件被守卫忽略，不误清。
    const handlePlaying = () => {
      if (activeVideoKeyRef.current === next)
        setFailedPet(null)
    }
    el.addEventListener('playing', handlePlaying)
    // 一次性动画每次进入都从动作起点开始；无元数据时跳过（新建视频首帧本就是 0）。
    if (ONCE_KEYS.has(next) && el.readyState >= 1)
      el.currentTime = 0
    el.play().catch(() => {})
    return () => {
      el.removeEventListener('playing', handlePlaying)
      const current = activeVideoKeyRef.current
      activeVideoKeyRef.current = null
      if (current === null)
        return
      const leaving = elements[current]
      if (leaving) {
        leaving.pause()
        if (ONCE_KEYS.has(current))
          leaving.currentTime = 0
      }
    }
  }, [activeVideoKey, isVisible, videoPoolReady])

  // 点击任务在卸载时回收；会话 Toast 与宠物共用当前 WebView 的 queue。
  useEffect(() => {
    return () => {
      clearClickTimer()
      clearSessionToasts()
      toast.clear()
    }
  }, [])

  function syncSessionToasts(nextStatus: PetStatus) {
    const keys = sessionToastKeysRef.current
    const sessions = nextStatus.enabled && nextStatus.visible !== false ? (nextStatus.sessions ?? []) : []
    const active = new Map<string, { description: string, title: string }>()
    for (const session of sessions) {
      if (typeof session.id !== 'string' || session.id.length === 0)
        continue
      if (session.activity === 'idle')
        continue
      // 会话标题固定、描述实时：标题在创建 toast 时写入，描述随每次推送刷新。
      active.set(session.id, { description: sessionBubbleDescription(session), title: sessionBubbleTitle(session) })
      sessionBubbleStore.set(session.id, sessionBubbleDescription(session))
    }
    for (const [id, key] of keys) {
      if (!active.has(id)) {
        toast.close(key)
        keys.delete(id)
        sessionBubbleStore.delete(id)
      }
    }
    for (const [id, presentation] of active) {
      const key = keys.get(id)
      if (key === undefined) {
        // 会话 Toast 必须常驻至会话结束：显式 timeout 0（HeroUI 持久 Toast 哨兵）。
        const created = toast(presentation.title, {
          placement: 'top',
          timeout: 0,
          description: <SessionBubble sessionId={id} />,
          onClose: () => {
            if (keys.get(id) === created) {
              keys.delete(id)
              sessionBubbleStore.delete(id)
            }
          },
        })
        keys.set(id, created)
      }
    }
  }

  function clearSessionToasts() {
    const keys = sessionToastKeysRef.current
    for (const key of keys.values())
      toast.close(key)
    for (const id of keys.keys())
      sessionBubbleStore.delete(id)
    keys.clear()
  }

  function clearClickTimer() {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
  }

  function handleAnimationEnded(key: VideoKey) {
    // 抢占守卫：播放期间已切走的旧视频，其 ended 回调不再生效。
    if (key !== activeVideoKeyRef.current)
      return
    if (key === 'turn')
      setFacing(current => (current === 'left' ? 'right' : 'left'))
    if (localActivity !== null) {
      setLocalActivity(null)
      return
    }
    if (key === 'turn' || key === 'wave')
      setSessionActivity('idle')
  }

  function handleVideoError(key: VideoKey) {
    if (key === activeVideoKeyRef.current)
      setFailedPet(activePet)
  }

  function handleSpriteError() {
    setFailedPet(activePet)
  }

  function handleMediaLoaded(key: VideoKey) {
    if (key === activeVideoKeyRef.current)
      setFailedPet(null)
  }

  function handleSpriteLoaded(event: React.SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget
    if (visibleCustomAsset !== null) {
      const frameWidth = image.naturalWidth / visibleCustomAsset.columns
      const frameHeight = image.naturalHeight / visibleCustomAsset.rows
      if (frameWidth > 0 && frameHeight > 0)
        setSpriteAspect({ id: visibleCustomAsset.id, value: frameHeight / frameWidth })
    }
    setFailedPet(null)
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0)
      return
    const requestId = dragRequestRef.current + 1
    dragRequestRef.current = requestId
    dragRef.current = {
      active: true,
      nativeStarted: true,
      pointerId: event.pointerId,
      requestId,
    }
    dragMachineRef.current = beginDrag(facing)
    setDragPhase(dragMachineRef.current.phase)
    // 交给操作系统追踪窗口。Windows 原生拖拽会正确处理跨显示器 DPI 切换，
    // 方向改由窗口物理位置增量驱动，不再把不同坐标系的 PointerEvent 增量换算成窗口像素。
    void performNativeDrag(requestId)
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    console.log('----')
    const drag = dragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId)
      return
    // startDragging 的 Promise 在系统结束拖拽后负责区分点击与实际移动。
    if (!drag.nativeStarted)
      finishPetInteraction(false)
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (drag.pointerId !== event.pointerId)
      return
    // 取消视为一次拖动结束：先进入 ending，再复位且不触发挥手。
    dragMachineRef.current = endDrag(dragMachineRef.current)
    setDragPhase('ending')
    finishPetInteraction(true)
  }

  function handleDoubleClick() {
    dragRequestRef.current += 1
    dragRef.current.active = false
    dragMachineRef.current = resetDrag()
    setDragPhase('idle')
    clearClickTimer()
    if (isWorkLocked || sessionActivity === 'review' || sessionActivity === 'failed')
      return
    setLocalActivity('bubble')
  }
  async function performNativeDrag(requestId: number) {
    const appWindow = getCurrentWindow()
    const originPromise = appWindow.outerPosition()
    try {
      const nativeDrag = appWindow.startDragging()
      const origin = await originPromise
      await nativeDrag
      const position = await appWindow.outerPosition()
      if (dragRequestRef.current !== requestId)
        return
      const moved = position.x !== origin.x || position.y !== origin.y
        || hasDragged(dragMachineRef.current)
      finishPetInteraction(moved)
    }
    catch (error) {
      if (dragRequestRef.current === requestId)
        finishPetInteraction(false)
      console.warn('[pet] native drag failed:', error)
    }
  }

  function finishPetInteraction(moved: boolean) {
    const drag = dragRef.current
    drag.active = false
    drag.nativeStarted = false
    // 结束拖动：复位状态机到 idle，并停掉此前的方向覆盖；
    // 会话活动从不在此处改写成 idle，交给 resolvePetActivity 按 dragging→session→交互 回落。
    dragMachineRef.current = resetDrag()
    setDragPhase('idle')
    if (moved) {
      setLocalActivity(null)
      return
    }
    clearClickTimer()
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      if (isWorkLocked || sessionActivityRef.current === 'review' || sessionActivityRef.current === 'failed')
        return
      // 无状态单击只播放挥手动画，不再弹 Toast。
      setLocalActivity('waving')
    }, CLICK_DELAY_MS)
  }

  return (
    <main className="pet-stage" data-visible={isVisible}>
      <If cond={isVisible}>
        <div className="pet-anchor" style={petStyle} data-sprite={usesCustomSprite}>
          <div
            className="pet-hit-area"
            aria-label={copy.petLabel}
            data-activity={activity}
            data-active-pet={activePet}
            onDoubleClick={handleDoubleClick}
            onPointerCancel={handlePointerCancel}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            role="img"
          >
            <If cond={videoPoolReady}>
              {VIDEO_KEYS.map(key => (
                <video
                  key={key}
                  ref={(el) => {
                    videoElementsRef.current[key] = el
                  }}
                  className="pet-video"
                  data-active={activeVideoKey === key}
                  data-facing={visual.facing}
                  loop={!ONCE_KEYS.has(key)}
                  muted
                  onEnded={() => handleAnimationEnded(key)}
                  onError={() => handleVideoError(key)}
                  onLoadedData={() => handleMediaLoaded(key)}
                  playsInline
                  preload="auto"
                  src={builtinAssetUrl(key, builtinAssets)}
                />
              ))}
            </If>
            <If cond={usesCustomSprite && visibleCustomAsset !== null}>
              <div
                ref={spriteRef}
                className="pet-sprite"
                data-facing={facing}
                style={{
                  backgroundImage: visibleCustomAsset ? `url(${visibleCustomAsset.spritesheet})` : undefined,
                  backgroundPosition: visibleCustomAsset
                    ? getSpriteFramePosition(getSpriteSequence(activity, facing, reducedMotion).frames[0], visibleCustomAsset.columns, visibleCustomAsset.rows)
                    : undefined,
                  backgroundSize: visibleCustomAsset ? `${visibleCustomAsset.columns * 100}% ${visibleCustomAsset.rows * 100}%` : undefined,
                }}
              />
              <img
                className="pet-sprite-probe"
                src={visibleCustomAsset?.spritesheet}
                alt=""
                draggable={false}
                onError={handleSpriteError}
                onLoad={handleSpriteLoaded}
              />
            </If>
            <If cond={mediaFailed}>
              <If cond={whaleFallbackUrl !== undefined && !fallbackFailed}>
                <img
                  className="pet-fallback"
                  src={whaleFallbackUrl}
                  alt=""
                  draggable={false}
                  onError={() => setFallbackFailed(true)}
                />
              </If>
              <If cond={whaleFallbackUrl === undefined || fallbackFailed}>
                <span className="pet-media-error" role="status">PET_BUILTIN_ASSET_UNAVAILABLE</span>
              </If>
            </If>
          </div>
        </div>
      </If>
    </main>
  )
}

function builtinAssetUrl(key: BuiltinAssetKey, assets: Record<string, string>): string | undefined {
  return assets[key]
}

function assetKeyForVisual(asset: string): VideoKey {
  if (asset === 'maid-turn.webm')
    return 'turn'
  if (asset === 'maid-move.webm')
    return 'move'
  if (asset === 'maid-wave.webm')
    return 'wave'
  if (asset === 'maid-waiting.webm')
    return 'waiting'
  if (asset === 'maid-running.webm')
    return 'running'
  if (asset === 'maid-review.webm')
    return 'review'
  if (asset === 'maid-failed.webm')
    return 'failed'
  if (asset === 'maid-bubble.webm')
    return 'bubble'
  return 'idle'
}

function isSupportedAsset(value: PetAsset): boolean {
  return value.sprite_version_number === 2
    && value.columns === 8
    && value.rows === 11
    && typeof value.spritesheet === 'string'
    && value.spritesheet.length > 0
}

function normalizeActivePet(value: string | null | undefined): string {
  const normalized = value?.trim()
  return normalized || BUILT_IN_PET_ID
}

function normalizePetSize(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return PET_DEFAULT_SIZE_PERCENT
  return Math.min(200, Math.max(50, value))
}

function getCopy(): Copy {
  const language = document.documentElement.lang || navigator.language
  return language.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
}
