import type { CSSProperties, Ref, RefObject, SyntheticEvent } from 'react'
import type { PetHandle, PetStatus } from '../hooks/use-pet'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import { If } from 'react-if-lite'
import { PET_STATUSES } from '../hooks/use-pet'

const BUILT_IN_PET_ID = 'maid-deepseek-whale'
const PET_BASE_WIDTH = 220
const PET_DEFAULT_SIZE_PERCENT = 100
const PET_SIZE_MIN_PERCENT = 50
const PET_SIZE_MAX_PERCENT = 200
/** 透明窗口右侧留白（逻辑像素），与 Rust pet_window_logical_size 的 PAD 常量一致。 */
const PET_WINDOW_PAD_X = 32
/** 顶部 Toast 区 + 底部留白（逻辑像素），与 Rust 的 TOP_PAD + BOTTOM_PAD 一致。 */
const PET_WINDOW_PAD_Y = 82
/** 顶栏 Toast 区的最小窗口宽度（逻辑像素），与 Rust pet_window_logical_size 的 MIN_WIDTH 一致。 */
const PET_BUBBLE_MIN_WIDTH = 420
const IDLE_DURATIONS = [280, 110, 110, 140, 140, 320] as const
/**
 * 待机转向插播间隔下限/上限（ms）：平时以循环待机动画为主（参考 dsh-pet
 * animationWeights idle:10 / turn:5 的权重语义——turn 是播完掷骰链里的低频事件），
 * 只有长时间持续待机才偶尔插播一次转身，避免高频切换的观感。
 */
const IDLE_TURN_DELAY_MIN = 25000
const IDLE_TURN_DELAY_MAX = 50000
/**
 * 拖拽/点击命中区（视频筐内百分比），与 dsh-pet 的 HIT_BOX 一致
 * （source/dsh-pet/dsh-pet/src/shared/constants.ts:8，640×360 画布坐标
 * x0:200 y0:50 x1:440 y1:335）：命中区 = 宠物身体，视频/空白区不响应事件。
 */
const PET_HIT_BOX = { left: '31.25%', top: '13.8888888889%', width: '37.5%', height: '79.1666666667%' } as const
const ACTIONS = {
  'moving-right': { row: 1, frames: 8, duration: 120, lastDuration: 220 },
  'moving-left': { row: 2, frames: 8, duration: 120, lastDuration: 220 },
  'waving': { row: 3, frames: 4, duration: 140, lastDuration: 280 },
  'failed': { row: 5, frames: 8, duration: 140, lastDuration: 240 },
  'waiting': { row: 6, frames: 6, duration: 150, lastDuration: 260 },
  'running': { row: 7, frames: 6, duration: 120, lastDuration: 220 },
  'review': { row: 8, frames: 6, duration: 150, lastDuration: 280 },
} as const

type VideoKey = 'idle' | 'turn' | 'move' | 'drag' | 'wave' | 'waiting' | 'running' | 'review' | 'failed' | 'bubble'
type Animation = PetStatus | 'bubble' | 'dragging'

interface Asset {
  columns: number
  id: string
  rows: number
  sprite_version_number: number
  spritesheet: string
}

interface RustPetStatus {
  active_pet?: string | null
  enabled?: boolean
  pet_size?: number | null
  visible?: boolean | null
}

export interface PetProps {
  ref?: Ref<PetHandle | null>
  hitboxRef?: RefObject<HTMLDivElement | null>
  status?: PetStatus
  /** 原生拖拽会话进行中；内置宠物据此播放拖拽浮动动画（忽略方向）。 */
  dragging?: boolean
  /**
   * 点击计次（useDrag 判定「按下-松开且窗口未达拖拽阈值 = 点击」后递增）；
   * 变化时播放一次点击回应动画（waving）。不依赖 DOM click/dblclick 合成。
   */
  clickCount?: number
}

interface Frame {
  column: number
  duration: number
  row: number
}

/** 桌宠唯一视觉组件：资源加载、WebM/Codex v2 播放和 Tauri 窗口细节全部封装。 */
export function Pet(props: PetProps) {
  const [rustStatus, setRustStatus] = useState<RustPetStatus>({ enabled: true, visible: true })
  const [assets, setAssets] = useState<Record<string, string>>({})
  const [customAsset, setCustomAsset] = useState<Asset | null>(null)
  const [customAssetPet, setCustomAssetPet] = useState<string | null>(null)
  const [spriteAspect, setSpriteAspect] = useState<{ id: string, value: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [override, setOverride] = useState<{ loop: boolean, revision: number, status: PetStatus } | null>(null)
  const revisionRef = useRef(0)
  const [adHoc, setAdHoc] = useState<{ seq: number, status: 'turn' | 'waving' } | null>(null)
  const adHocRef = useRef(adHoc)
  adHocRef.current = adHoc
  const adHocSeqRef = useRef(0)
  const [reducedMotion, setReducedMotion] = useState(() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const videoARef = useRef<HTMLVideoElement | null>(null)
  const videoBRef = useRef<HTMLVideoElement | null>(null)
  const frontIdxRef = useRef(0)
  const [frontIdx, setFrontIdx] = useState(0)
  const pendingRef = useRef<null | { anim: Animation, gen: number, once: boolean, revision: number | undefined, seq: number }>(null)
  const genRef = useRef(0)
  const spriteRef = useRef<HTMLDivElement | null>(null)
  const overrideRef = useRef(override)
  overrideRef.current = override
  const prevClickRef = useRef(0)
  const handleEndedRef = useRef<(event?: Event) => void>(() => {})

  const activePet = normalizeActivePet(rustStatus.active_pet)
  const isBuiltin = activePet === BUILT_IN_PET_ID
  // 内置宠物拖拽中：播放拖拽悬空浮动动画（不区分方向）；自定义宠物仍用方向转向。
  const dragHold = props.dragging === true && isBuiltin
  // 优先级：拖拽浮动动画 > 手势方向 > 一次性回应（点击 waving / 待机 turn） > ref 命令（会话状态）> 默认 idle。
  // 一次性动画在 override 之上但低于手势方向：点击回应可打断会话状态，拖拽方向仍优先。
  const activity: Animation = dragHold ? 'dragging' : props.status ?? adHoc?.status ?? override?.status ?? 'idle'
  const size = normalizePetSize(rustStatus.pet_size)
  const visible = rustStatus.enabled !== false && rustStatus.visible !== false
  const hasCustomAsset = customAsset !== null && customAssetPet === activePet
  // 自定义精灵图使用加载后探测到的真实画布比例（帧高/帧宽），未探测到前回落到图集默认比例。
  const petAspect = isBuiltin ? 9 / 16 : (spriteAspect?.id === activePet ? spriteAspect.value : 208 / 192)

  useImperativeHandle(props.ref, () => ({
    change(options) {
      if (isPetStatus(options.status))
        setOverride({ loop: options.loop === true, revision: ++revisionRef.current, status: options.status })
    },
    clear() {
      setOverride(null)
    },
    get status() {
      return props.status ?? overrideRef.current?.status ?? 'idle'
    },
  }), [props.status])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<RustPetStatus>('pet://status', (event) => {
      if (!disposed)
        setRustStatus(event.payload)
    }).then((dispose) => {
      if (disposed)
        dispose()
      else
        unlisten = dispose
    }).catch(() => {})
    void invoke<RustPetStatus>('get_pet_status').then((value) => {
      if (!disposed)
        setRustStatus(value)
    }).catch(() => {})
    void invoke<{ assets?: Record<string, string> }>('get_builtin_pet_assets').then((value) => {
      if (!disposed)
        setAssets(value.assets ?? {})
    }).catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (query === undefined)
      return undefined
    function updateMotion() {
      setReducedMotion(query.matches)
    }
    query.addEventListener('change', updateMotion)
    return () => query.removeEventListener('change', updateMotion)
  }, [])

  useEffect(() => {
    if (isBuiltin)
      return undefined
    let disposed = false
    void invoke<Asset>('get_pet_asset', { id: activePet }).then((value) => {
      if (!disposed && isSupportedAsset(value)) {
        setCustomAsset(value)
        setCustomAssetPet(activePet)
      }
    }).catch(() => {})
    return () => {
      disposed = true
    }
  }, [activePet, isBuiltin])

  // 原生窗口尺寸跟随当前资源真实画布比例缩放（设置页 drag 滑块实时生效），
  // 避免与 Rust 只按图集默认比例重设窗口导致两处 set_size 打架（issue #308）。
  useEffect(() => {
    if (!visible)
      return undefined
    const appWindow = getCurrentWindow()
    // 气泡常驻窗口右侧留白之上，窗口宽度兜底到气泡可读宽度；宠物锚定右侧，
    // 加宽窗口只向左扩展透明区，宠物在屏幕上的位置保持不变。
    const width = Math.max((PET_BASE_WIDTH * size) / 100 + PET_WINDOW_PAD_X, PET_BUBBLE_MIN_WIDTH)
    const height = (PET_BASE_WIDTH * size) / 100 * petAspect + PET_WINDOW_PAD_Y
    void appWindow.setSize(new LogicalSize(width, height)).then(() => {
      // 放大后把窗口夹回可见显示器，避免右侧/底部被推出屏幕。
      void invoke<void>('move_pet_window', { deltaX: 0, deltaY: 0 }).catch(() => {})
    }).catch((error) => {
      console.warn('[pet] PET_WINDOW_RESIZE_FAILED:', error)
    })
  }, [petAspect, size, visible])

  useEffect(() => {
    // 双 video 缓冲切换（移植 dsh-pet switchTo）：新动画先在后台视频加载，
    // loadeddata 后才交换前台并淡入，旧视频淡出 + pause + 清 onended（拆雷，
    // 防止后台残留事件掐断前台动画）；全程无空窗/黑帧，动画切换不闪跳。
    if (isBuiltin === false || videoARef.current === null || videoBRef.current === null)
      return undefined
    const source = assets[videoKey(activity)] ?? (activity === 'dragging' ? assets.move : undefined)
    if (source === undefined)
      return undefined
    const once = !(override?.loop ?? isLoopingAnimation(activity))
    const revision = override?.revision
    // adHoc seq：点击同一动画（waving→waving）时 seq 递增强制重播（对应 dsh-pet 的 seq 重放）。
    const seq = adHoc?.seq ?? 0
    const pending = pendingRef.current
    // 防重：同一动画 + 同一 revision + 同一 seq（未显式重播）不重复加载；
    // override/点击每次触发 revision/seq 递增，同动画重播仍会重载并从头播放。
    if (pending !== null && pending.anim === activity && pending.once === once
      && pending.revision === revision && pending.seq === seq) {
      return undefined
    }
    const gen = ++genRef.current
    pendingRef.current = { anim: activity, gen, once, revision, seq }
    const target = frontIdxRef.current === 0 ? videoBRef.current : videoARef.current
    target.src = source
    target.loop = !once
    target.onended = once ? event => handleEndedRef.current(event) : null
    target.load()
    const onReady = () => {
      target.removeEventListener('loadeddata', onReady)
      if (pendingRef.current?.gen !== gen)
        return // 已被更新的切换取代
      const old = frontIdxRef.current === 0 ? videoARef.current : videoBRef.current
      if (old !== null && old !== target) {
        old.onended = null // 拆雷：后台残留 onended 会掐断前台动画
        old.pause()
      }
      frontIdxRef.current = frontIdxRef.current === 0 ? 1 : 0
      // 交换前台发生在 loadeddata 事件回调（或视频已就绪的立即分支）：属于响应加载完成，
      // 而非渲染副作用；规则无法区分事件回调与 effect 同步阶段，忽略。
      // eslint-disable-next-line react/set-state-in-effect
      setFrontIdx(frontIdxRef.current)
      pendingRef.current = null
      void target.play().catch(() => setFailed(true))
    }
    target.addEventListener('loadeddata', onReady)
    if (target.readyState >= 2)
      onReady()
    return () => {
      target.removeEventListener('loadeddata', onReady)
      // 若本次加载尚未完成（StrictMode 双挂载 / 依赖变化提前清理），清掉 pending，
      // 让下一次 effect 重新发起加载，避免「监听器已移除但 pending 仍在」的死锁。
      if (pendingRef.current?.gen === gen)
        pendingRef.current = null
    }
  }, [activity, adHoc?.seq, assets, isBuiltin, override?.loop, override?.revision])

  // 点击回应：clickCount 变化（useDrag 判定「500ms 内两次按下且未拖拽 = 双击」后递增）
  // → 播放一次 waving。adHoc 优先级在会话 override 之上：双击回应可打断会话状态，
  // 播完回落原动画（handleEnded）。
  useEffect(() => {
    if (props.clickCount === undefined || props.clickCount === prevClickRef.current)
      return undefined
    prevClickRef.current = props.clickCount
    // 点击回应：以 props 变化驱动一次性动画状态，属于事件联动而非渲染副作用。
    // eslint-disable-next-line react/set-state-in-effect
    setAdHoc({ seq: ++adHocSeqRef.current, status: 'waving' })
  }, [props.clickCount])

  // 待机转向链（参考 dsh-pet 的权重掷骰链）：内置宠物长时间持续待机时，
  // 才以低频（IDLE_TURN_DELAY_MIN~MAX 随机）插播一次转身动画，平时保持循环待机。
  useEffect(() => {
    if (isBuiltin === false || reducedMotion || activity !== 'idle')
      return undefined
    const delay = IDLE_TURN_DELAY_MIN + Math.random() * (IDLE_TURN_DELAY_MAX - IDLE_TURN_DELAY_MIN)
    const timer = window.setTimeout(setAdHoc, delay, { seq: ++adHocSeqRef.current, status: 'turn' })
    return () => window.clearTimeout(timer)
  }, [activity, isBuiltin, reducedMotion])

  useEffect(() => {
    const sprite = spriteRef.current
    const asset = customAsset
    if (isBuiltin || asset === null || customAssetPet !== activePet || sprite === null)
      return undefined
    const element = sprite
    const loadedAsset = asset
    const sequence = spriteSequence(activity, reducedMotion, override?.loop ?? isLoopingAnimation(activity))
    let index = 0
    let timer: number | undefined
    function paint() {
      const frame = sequence.frames[index]
      element.style.backgroundPosition = framePosition(frame, loadedAsset.columns, loadedAsset.rows)
      if (sequence.frames.length > 1) {
        timer = window.setTimeout(() => {
          index = index + 1 >= sequence.frames.length ? (sequence.loopStart ?? index) : index + 1
          paint()
        }, frame.duration)
      }
    }
    paint()
    return () => {
      if (timer !== undefined)
        window.clearTimeout(timer)
    }
  }, [activity, activePet, adHoc?.seq, customAsset, customAssetPet, isBuiltin, override?.loop, reducedMotion])

  useEffect(() => {
    if (override?.loop !== false || override === null || isBuiltin || !hasCustomAsset)
      return undefined
    const frames = spriteAction(override.status)
    const duration = (reducedMotion ? [frames[0]] : frames).reduce((total, frame) => total + frame.duration, 0)
    const timer = window.setTimeout(setOverride, duration, null)
    return () => window.clearTimeout(timer)
  }, [hasCustomAsset, isBuiltin, override, reducedMotion])

  // 自定义精灵无 ended 事件：adHoc（点击回应/待机转向）播完按帧时长估算后清掉，
  // 让 activity 回落 idle（内置宠物由视频 ended 事件驱动，走 handleEnded）。
  useEffect(() => {
    if (adHoc === null || isBuiltin || !hasCustomAsset)
      return undefined
    const frames = spriteAction(adHoc.status)
    const duration = (reducedMotion ? [frames[0]] : frames).reduce((total, frame) => total + frame.duration, 0)
    const timer = window.setTimeout(setAdHoc, duration, null)
    return () => window.clearTimeout(timer)
  }, [adHoc, hasCustomAsset, isBuiltin, reducedMotion])

  function handleEnded(event?: Event) {
    // 只响应前台视频的 ended：被降级的后台视频在切换时已 pause + 清 onended（拆雷），
    // 不会触发；双保险再校验一次事件来源是否为当前前台视频。
    const source = event?.currentTarget as HTMLVideoElement | undefined
    const front = frontIdxRef.current === 0 ? videoARef.current : videoBRef.current
    if (source !== undefined && source !== front)
      return
    // 一次性动画播完：优先清 adHoc（点击回应 waving / 待机转向 turn），
    // 否则清非 loop 的 override 命令（bubble 会话动画播完回 idle）。
    if (adHocRef.current !== null) {
      setAdHoc(null)
      return
    }
    if (overrideRef.current?.loop !== true)
      setOverride(null)
  }
  handleEndedRef.current = handleEnded

  function handleSpriteLoaded(event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget
    if (customAsset !== null) {
      const frameWidth = image.naturalWidth / customAsset.columns
      const frameHeight = image.naturalHeight / customAsset.rows
      if (frameWidth > 0 && frameHeight > 0)
        setSpriteAspect({ id: customAsset.id, value: frameHeight / frameWidth })
    }
    setFailed(false)
  }

  const style = {
    '--pet-width': `${PET_BASE_WIDTH * size / 100}px`,
    '--pet-aspect': String(petAspect),
  } as CSSProperties

  return (
    <If cond={visible}>
      <main className="pointer-events-none fixed inset-0 flex items-end justify-center overflow-visible" style={style}>
        {/* 视频筐本身不响应事件：可交互面收缩到下方 PET_HIT_BOX 命中区（与 dsh-pet
            .dsh-pet-hit 一致），事件从命中区冒泡到 app.tsx 的 dragRef 壳触发拖拽。 */}
        <div className="pointer-events-none relative h-[calc(var(--pet-width)*var(--pet-aspect))] w-[var(--pet-width)] select-none">
          <If cond={isBuiltin}>
            {/* 双 video 缓冲：前台 opacity-100 淡入、后台 opacity-0 淡出，
                切换经 loadeddata 就绪后交换（见开关 effect），无空窗/黑帧闪跳。
                视频均 pointer-events-none，避免截获命中区外的点击。 */}
            <video
              ref={videoARef}
              className={`pointer-events-none absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${frontIdx === 0 ? 'opacity-100' : 'opacity-0'}`}
              muted
              playsInline
              preload="auto"
              onError={() => setFailed(true)}
            />
            <video
              ref={videoBRef}
              className={`pointer-events-none absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${frontIdx === 1 ? 'opacity-100' : 'opacity-0'}`}
              muted
              playsInline
              preload="auto"
              onError={() => setFailed(true)}
            />
          </If>
          <If cond={!isBuiltin && hasCustomAsset}>
            <div
              ref={spriteRef}
              className="pointer-events-none absolute inset-0 bg-contain bg-no-repeat"
              style={{
                backgroundImage: customAsset ? `url(${customAsset.spritesheet})` : undefined,
                backgroundSize: customAsset ? `${customAsset.columns * 100}% ${customAsset.rows * 100}%` : undefined,
              }}
            />
            {/* 探测精灵图真实像素尺寸，换算成帧比例供窗口缩放使用；0×0 不可见。 */}
            <img
              className="pointer-events-none absolute h-0 w-0 opacity-0"
              src={customAsset?.spritesheet}
              alt=""
              draggable={false}
              onError={() => setFailed(true)}
              onLoad={handleSpriteLoaded}
            />
          </If>
          <If cond={failed && assets.fallback !== undefined}>
            <img className="pointer-events-none absolute inset-0 h-full w-full object-contain" src={assets.fallback} alt="" draggable={false} />
          </If>
          {/* 命中区：唯一可交互面（拖拽/双击），尺寸与 dsh-pet .dsh-pet-hit 一致。 */}
          <div
            ref={props.hitboxRef}
            className="pointer-events-auto absolute cursor-grab touch-none select-none"
            style={PET_HIT_BOX}
          />
        </div>
      </main>
    </If>
  )
}

function isPetStatus(value: string): value is PetStatus {
  return (PET_STATUSES as readonly string[]).includes(value)
}

function normalizeActivePet(value: string | null | undefined): string {
  const normalized = value?.trim()
  return normalized || BUILT_IN_PET_ID
}

function normalizePetSize(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return PET_DEFAULT_SIZE_PERCENT
  return Math.min(PET_SIZE_MAX_PERCENT, Math.max(PET_SIZE_MIN_PERCENT, value))
}

function isSupportedAsset(value: Asset): boolean {
  return value.sprite_version_number === 2
    && value.columns === 8
    && value.rows === 11
    && typeof value.spritesheet === 'string'
    && value.spritesheet.length > 0
}

function isLoopingAnimation(activity: Animation): boolean {
  // moving-* 与 dragging 仅存在于原生拖拽期间（手势状态），持续播放直到拖拽结束。
  return activity === 'idle' || activity === 'running'
    || activity === 'moving-left' || activity === 'moving-right'
    || activity === 'dragging'
}

function videoKey(activity: Animation): VideoKey {
  if (activity === 'moving-left' || activity === 'moving-right')
    return 'move'
  if (activity === 'dragging')
    return 'drag'
  if (activity === 'waving')
    return 'wave'
  if (activity === 'bubble')
    return 'bubble'
  return activity
}

function spriteSequence(activity: Animation, reducedMotion: boolean, loop: boolean): { frames: Frame[], loopStart: number | null } {
  const idleFrames = IDLE_DURATIONS.map((duration, column) => ({ column, duration: duration * 6, row: 0 }))
  const action = spriteAction(activity)
  if (activity === 'idle')
    return reducedMotion ? { frames: [idleFrames[0]], loopStart: 0 } : { frames: idleFrames, loopStart: 0 }
  if (reducedMotion)
    return { frames: [action[0]], loopStart: loop ? 0 : null }
  if (loop)
    return { frames: action, loopStart: 0 }
  return { frames: [...action, ...idleFrames], loopStart: action.length }
}

function spriteAction(activity: Animation): Frame[] {
  if (activity === 'idle')
    return IDLE_DURATIONS.map((duration, column) => ({ column, duration, row: 0 }))
  const mapped = activity === 'turn' ? 'moving-right' : activity === 'bubble' ? 'waving' : activity === 'dragging' ? 'moving-right' : activity
  const config = ACTIONS[mapped]
  return Array.from({ length: config.frames }, (_, column) => ({
    column,
    duration: column === config.frames - 1 ? config.lastDuration : config.duration,
    row: config.row,
  }))
}

function framePosition(frame: Frame, columns: number, rows: number): string {
  return `${frame.column * 100 / Math.max(1, columns - 1)}% ${frame.row * 100 / Math.max(1, rows - 1)}%`
}
