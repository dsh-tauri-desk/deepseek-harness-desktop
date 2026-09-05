import type { CSSProperties, Ref, RefObject, SyntheticEvent } from 'react'
import type { PetHandle, PetStatus } from '../hooks/use-pet'
import type { PetConfig } from '../pet-config'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { If } from 'react-if-lite'
import { PET_STATUSES } from '../hooks/use-pet'
import {
  pick,
  pickCategoryAction,
  poolEntryToStatus,
  resolvePresetName,
  rollKind,
} from '../pet-config'

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
 * 待机转向插播间隔下限/上限（ms）：平时以循环待机动画为主，参考 dsh-pet
 * animationWeights idle:10 / turn:5 的权重语义——turn 是播完掷骰链里的低频事件，
 * 只有长时间持续待机才偶尔插播一次转身，避免高频切换的观感。
 * 当内置 config.jsonc 可用时，实际掷骰改由协议权重（rollKind）驱动，这两个
 * 常量仅作为「每次掷骰的间隔」使用。
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
  const [customAsset, setCustomAsset] = useState<Asset | null>(null)
  const [customAssetPet, setCustomAssetPet] = useState<string | null>(null)
  const [spriteAspect, setSpriteAspect] = useState<{ id: string, value: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [override, setOverride] = useState<{ loop: boolean, revision: number, status: PetStatus } | null>(null)
  const revisionRef = useRef(0)
  const [adHoc, setAdHoc] = useState<{ seq: number, status: string } | null>(null)
  const adHocRef = useRef(adHoc)
  adHocRef.current = adHoc
  const adHocSeqRef = useRef(0)
  // 预设宠物资源（config.jsonc + webm manifest）：按宠物 id 一起拉取并整体更新，
  // 避免切换宠物时残留上一个宠物的动画池/URL（旧数据在 fetch 完成前不生效）。
  const [petResources, setPetResources] = useState<{
    pet: string
    config: PetConfig | null
    assets: Record<string, string>
  } | null>(null)
  const [reducedMotion, setReducedMotion] = useState(() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const videoARef = useRef<HTMLVideoElement | null>(null)
  const videoBRef = useRef<HTMLVideoElement | null>(null)
  const frontIdxRef = useRef(0)
  const [frontIdx, setFrontIdx] = useState(0)
  const pendingRef = useRef<null | { anim: string, gen: number, once: boolean, revision: number | undefined, seq: number }>(null)
  const genRef = useRef(0)
  const spriteRef = useRef<HTMLDivElement | null>(null)
  const overrideRef = useRef(override)
  overrideRef.current = override
  const prevClickRef = useRef(0)
  const handleEndedRef = useRef<(event?: Event) => void>(() => {})

  const activePet = normalizeActivePet(rustStatus.active_pet)
  // 预设宠物（未限定 id，来自 ~/.dsh/pets 下载产物）走 WebM 协议渲染；
  // 来源限定 id（chat:/codex:）走 Codex v2 精灵图渲染。
  const isPreset = !activePet.includes(':')
  // 预设宠物资源按当前激活宠物生效：切换宠物时旧资源保持到新 fetch 完成，避免闪烁。
  // 统一 memo 成稳定的 config/assets 引用，避免每次渲染产生新对象导致视频 effect 重跑。
  const { config, assets } = useMemo(() => {
    const preset = petResources !== null && petResources.pet === activePet ? petResources : null
    return {
      config: preset?.config ?? null,
      assets: preset?.assets ?? {},
    }
  }, [activePet, petResources])
  // 预设宠物配置驱动动画池：池条目是动画名（webm 文件名主名，如 待机呼吸休闲），
  // 点击/拖拽/待机链按名字从 assets map 取 URL。配置缺失或命令失败时回落与旧
  // 实现一致的默认池（idle/turn/wave），这些名字在 assets 中不存在时自然不播放。
  const pools = useMemo(() => {
    const animations = config?.animations
    return {
      idlePool: animations?.idle.length ? animations.idle : ['idle'],
      turnPool: animations?.turn.length ? animations.turn : ['turn'],
      dragPool: animations?.drag.length ? animations.drag : ['drag'],
      clicksPool: animations?.clicks.length ? animations.clicks : ['wave'],
      categories: animations?.categories ?? [],
      weights: config?.animationWeights ?? { idle: 10, turn: 5, move: 5 },
    }
  }, [config])
  const { idlePool, turnPool, clicksPool, categories, weights } = pools

  // 预设宠物拖拽中：播放拖拽悬空浮动动画（不区分方向）；自定义宠物仍用方向转向。
  const dragHold = props.dragging === true && isPreset
  // 优先级：拖拽浮动动画 > 手势方向 > 一次性回应（点击/待机链，预设宠物池条目即动画名） > ref 命令（会话状态）> 默认 idle。
  // 一次性动画在 override 之上但低于手势方向：点击回应可打断会话状态，拖拽方向仍优先。
  const activity: Animation | string = dragHold ? 'dragging' : props.status ?? adHoc?.status ?? override?.status ?? 'idle'
  const size = normalizePetSize(rustStatus.pet_size)
  const visible = rustStatus.enabled !== false && rustStatus.visible !== false
  const hasCustomAsset = customAsset !== null && customAssetPet === activePet
  // 预设 WebM 画布 16:9（高/宽 = 9/16，与 dsh-pet 协议一致）；自定义精灵图用
  // 加载后探测到的真实画布比例（帧高/帧宽），未探测到前回落到图集默认比例。
  const petAspect = isPreset ? 9 / 16 : (spriteAspect?.id === activePet ? spriteAspect.value : 208 / 192)

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
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // 预设宠物按 activePet 拉取协议配置与媒体 manifest；切换宠物时重载。
  // 已安装预设的 config.jsonc 池条目（待机呼吸休闲 等）即 webm 文件名主名，
  // assets map 的 key 与池条目一一对应，动画链/点击/拖拽直接按名字取 URL。
  useEffect(() => {
    if (isPreset === false)
      return undefined
    let disposed = false
    void Promise.all([
      invoke<PetConfig>('get_preset_pet_config', { id: activePet }).catch((error) => {
        console.warn('[pet] PET_PRESET_CONFIG_LOAD_FAILED:', error)
        return null
      }),
      invoke<{ assets?: Record<string, string> }>('get_preset_pet_assets', { id: activePet }).catch((error) => {
        console.warn('[pet] PET_PRESET_ASSETS_LOAD_FAILED:', error)
        return { assets: {} }
      }),
    ]).then(([config, value]) => {
      if (disposed)
        return
      // 一起提交，避免 config 与 assets 不同步导致短暂按旧池解析。
      setPetResources({ pet: activePet, config, assets: value.assets ?? {} })
    })
    return () => {
      disposed = true
    }
  }, [activePet, isPreset])

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
    // 窗口由隐藏恢复显示（主 webview 重新开启宠物）时，WebView2 在隐藏窗口
    // 上可能暂停媒体播放；这里在 visible 恢复为 true 时重放前台视频，避免
    // 宠物「显示出来但静止不动」。元素始终常驻 DOM（CSS invisible），无需重载 src。
    if (!visible)
      return undefined
    const front = frontIdxRef.current === 0 ? videoARef.current : videoBRef.current
    if (front !== null && front.paused && front.src !== '' && !front.error) {
      void front.play().catch(() => setFailed(true))
    }
    return undefined
  }, [visible])

  useEffect(() => {
    if (isPreset)
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
  }, [activePet, isPreset])

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
    // 只用于预设宠物（WebM）；自定义宠物走精灵图渲染，不走视频。
    if (isPreset === false || videoARef.current === null || videoBRef.current === null)
      return undefined
    // 预设配置池条目 = 动画名 = webm 文件名主名；adHoc 已携带动画名时直接命中，
    // 会话状态（waiting/running/review/failed/bubble）经 PRESET_SESSION_ANIMATIONS
    // 叠加映射到具体动画名（写代码/轻快记录/玩游戏气急败坏…），映射名无资产时
    // resolvePresetName 返回 null → 保持当前动画。
    const name = resolvePresetName(activity, pools, assets)
    if (name === null)
      return undefined
    const source = assets[name]
    if (source === undefined)
      return undefined
    const once = !(override?.loop ?? isLoopingAnimation(activity))
    const revision = override?.revision
    // adHoc seq：点击同一动画时 seq 递增强制重播（对应 dsh-pet 的 seq 重放）。
    const seq = adHoc?.seq ?? 0
    const pending = pendingRef.current
    // 防重：同一动画名 + 同一 revision + 同一 seq（未显式重播）不重复加载；
    // override/点击每次触发 revision/seq 递增，同动画重播仍会重载并从头播放。
    if (pending !== null && pending.anim === name && pending.once === once
      && pending.revision === revision && pending.seq === seq) {
      return undefined
    }
    const gen = ++genRef.current
    pendingRef.current = { anim: name, gen, once, revision, seq }
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
  }, [activity, adHoc?.seq, assets, isPreset, override?.loop, override?.revision, pools])

  // 点击回应：clickCount 变化（useDrag 判定「500ms 内两次按下且未拖拽 = 双击」后递增）
  // → 播放一次点击回应动画。adHoc 优先级在会话 override 之上：双击回应可打断会话状态，
  // 播完回落原动画（handleEnded）。动画名来自预设 config.jsonc 的 clicks 池（协议，
  // 池条目 = 动画名 = webm 文件名主名）；配置缺失/池条目不可播放时不设 adHoc——
  // 宁可这次点击无回应，也不能把 activity 卡在永远无法播放的 adHoc 名字上
  // （adHoc 只能靠视频 ended 事件清除，播不出来就卡死待机链）。
  useEffect(() => {
    if (props.clickCount === undefined || props.clickCount === prevClickRef.current)
      return undefined
    prevClickRef.current = props.clickCount
    const entry = pick(clicksPool)
    if (isPreset) {
      // 预设：池条目必须是 assets 里真实存在的动画名才播；否则跳过本次回应。
      if (entry !== undefined && assets[entry] !== undefined) {
        // 点击回应：以 props 变化驱动一次性动画状态，属于事件联动而非渲染副作用。
        // eslint-disable-next-line react/set-state-in-effect
        setAdHoc({ seq: ++adHocSeqRef.current, status: entry })
      }
      return undefined
    }
    // 自定义宠物：池条目归一化失败时回落 waving 精灵动画（原行为）。
    const status = toAdHocStatus(entry) ?? 'waving'
    // eslint-disable-next-line react/set-state-in-effect
    setAdHoc({ seq: ++adHocSeqRef.current, status })
  }, [assets, clicksPool, isPreset, props.clickCount])

  // 待机链（dsh-pet 权重掷骰链）：预设宠物长时间持续待机时，以低频
  // （IDLE_TURN_DELAY_MIN~MAX 随机间隔）按 config.jsonc 的 animationWeights 掷骰，
  // 命中 turn/action 才插播一次一次性动画，平时保持循环待机。move 命中时因 DSH
  // 不自动漫游而保持待机（协议字段保留，行为对齐「移除自动移动」规格）。
  // 池条目即动画名：turn/action 命中的条目直接作为 adHoc.status 交给视频切换层；
  // 条目在 assets 里不存在时跳过本次掷骰（宁可继续待机，也不把 activity 卡在
  // 无法播放的 adHoc 名字上——adHoc 只靠视频 ended 清除，播不出来待机链就停摆）。
  useEffect(() => {
    if (isPreset === false || reducedMotion || activity !== 'idle')
      return undefined
    let timer: number | undefined
    function scheduleNextRoll() {
      const delay = IDLE_TURN_DELAY_MIN + Math.random() * (IDLE_TURN_DELAY_MAX - IDLE_TURN_DELAY_MIN)
      timer = window.setTimeout(() => {
        const kind = rollKind(Math.random(), weights)
        if (kind === 'turn' && turnPool.length > 0) {
          const status = pick(turnPool)
          if (status !== undefined && status !== 'idle' && assets[status] !== undefined) {
            setAdHoc({ seq: ++adHocSeqRef.current, status })
            return
          }
        }
        if (kind === 'action' && categories.length > 0) {
          const current = adHocRef.current?.status ?? 'idle'
          const action = pickCategoryAction(categories, idlePool, 'left', current)
          if (action.name !== undefined && action.name !== 'idle' && action.name !== current
            && assets[action.name] !== undefined) {
            setAdHoc({ seq: ++adHocSeqRef.current, status: action.name })
            return
          }
        }
        // idle / move（不自动漫游）/ 不可播放条目：继续待机并等待下一次掷骰。
        scheduleNextRoll()
      }, delay)
    }
    scheduleNextRoll()
    return () => window.clearTimeout(timer)
  }, [activity, assets, categories, idlePool, isPreset, reducedMotion, turnPool, weights])

  useEffect(() => {
    const sprite = spriteRef.current
    const asset = customAsset
    if (isPreset || asset === null || customAssetPet !== activePet || sprite === null)
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
  }, [activity, activePet, adHoc?.seq, customAsset, customAssetPet, isPreset, override?.loop, reducedMotion])

  useEffect(() => {
    if (override?.loop !== false || override === null || isPreset || !hasCustomAsset)
      return undefined
    const frames = spriteAction(override.status)
    const duration = (reducedMotion ? [frames[0]] : frames).reduce((total, frame) => total + frame.duration, 0)
    const timer = window.setTimeout(setOverride, duration, null)
    return () => window.clearTimeout(timer)
  }, [hasCustomAsset, isPreset, override, reducedMotion])

  // 自定义精灵无 ended 事件：adHoc（点击回应/待机转向）播完按帧时长估算后清掉，
  // 让 activity 回落 idle（预设宠物由视频 ended 事件驱动，走 handleEnded）。
  useEffect(() => {
    if (adHoc === null || isPreset || !hasCustomAsset)
      return undefined
    const frames = spriteAction(adHoc.status)
    const duration = (reducedMotion ? [frames[0]] : frames).reduce((total, frame) => total + frame.duration, 0)
    const timer = window.setTimeout(setAdHoc, duration, null)
    return () => window.clearTimeout(timer)
  }, [adHoc, hasCustomAsset, isPreset, reducedMotion])

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
    // 保持 <main> 与全部子元素（双 video、命中区）常驻 DOM，visible=false 时仅用
    // visibility:hidden 隐藏：隐藏/重开（主 webview 关闭宠物再开启）不会重挂载出
    // 新元素，useDrag 的监听器与视频加载 effect 都只绑定/加载一次，无需 F5 恢复；
    // 不用 display:none —— useOmitIgnoreCursorEvents 依赖 hitbox 的 getBoundingClientRect
    // 做鼠标穿透判定，display:none 会得到全 0 rect。窗口本身的显隐由 Rust 的
    // show/hide 控制，这里只负责 WebView 内部一致性。
    <main
      className={`pointer-events-none fixed inset-0 flex items-end justify-center overflow-visible ${visible ? '' : 'invisible'}`}
      style={style}
    >
      {/* 视频筐本身不响应事件：可交互面收缩到下方 PET_HIT_BOX 命中区（与 dsh-pet
          .dsh-pet-hit 一致），事件从命中区冒泡到 app.tsx 的 dragRef 壳触发拖拽。 */}
      <div className="pointer-events-none relative h-[calc(var(--pet-width)*var(--pet-aspect))] w-[var(--pet-width)] select-none">
        <If cond={isPreset}>
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
        <If cond={!isPreset && hasCustomAsset}>
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
  )
}

function isPetStatus(value: string): value is PetStatus {
  return (PET_STATUSES as readonly string[]).includes(value)
}

/**
 * 把预设配置池条目（动画名，webm 文件名主名）映射为可播放状态：预设宠物条目
 * 直接就是动画名（如 待机呼吸休闲 / 点击回应-开心跃动）；兼容旧内置键 'wave'
 * → 'waving' 的归一化。拖拽/方向专用状态不参与回应池；其余必须命中会话状态
 * 或 bubble，否则返回 null（调用方回落默认动画）。
 */
function toAdHocStatus(entry: string | undefined): string | null {
  if (entry === undefined)
    return null
  const status = poolEntryToStatus(entry)
  if (status === 'bubble')
    return status
  if (status === 'dragging' || status === 'moving-left' || status === 'moving-right')
    return null
  // 池条目为动画名时直接作为播放状态使用；其余必须是会话状态或 bubble。
  return isPetStatus(status) ? status : (status.length > 0 ? status : null)
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

function isLoopingAnimation(activity: Animation | string): boolean {
  // moving-* 与 dragging 仅存在于原生拖拽期间（手势状态），持续播放直到拖拽结束。
  return activity === 'idle' || activity === 'running'
    || activity === 'moving-left' || activity === 'moving-right'
    || activity === 'dragging'
}

function spriteSequence(activity: Animation | string, reducedMotion: boolean, loop: boolean): { frames: Frame[], loopStart: number | null } {
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

function spriteAction(activity: Animation | string): Frame[] {
  if (activity === 'idle')
    return IDLE_DURATIONS.map((duration, column) => ({ column, duration, row: 0 }))
  const mapped = activity === 'turn' ? 'moving-right' : activity === 'bubble' ? 'waving' : activity === 'dragging' ? 'moving-right' : activity
  const config = ACTIONS[mapped as keyof typeof ACTIONS] ?? ACTIONS.waving
  return Array.from({ length: config.frames }, (_, column) => ({
    column,
    duration: column === config.frames - 1 ? config.lastDuration : config.duration,
    row: config.row,
  }))
}

function framePosition(frame: Frame, columns: number, rows: number): string {
  return `${frame.column * 100 / Math.max(1, columns - 1)}% ${frame.row * 100 / Math.max(1, rows - 1)}%`
}
