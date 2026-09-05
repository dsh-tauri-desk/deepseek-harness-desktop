import type { RefObject } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useRef, useState } from 'react'

/** 拖拽的水平方向。 */
export type DragDirection = 'left' | 'right'

export interface UseDragResult {
  /** 原生拖拽会话进行中（按下后开始，结束/超时后为 false）。 */
  dragging: boolean
  /** 当前拖拽方向；未拖拽、位移不足或拖拽停顿时为 undefined。 */
  direction: DragDirection | undefined
  /**
   * 双击计次（两次按下间隔 < DOUBLE_CLICK_MS 且期间未进入拖拽）：驱动点击回应动画
   * （waving）。不依赖 DOM click/dblclick 事件合成——Windows 原生拖拽会吞掉
   * pointerup，click/dblclick 永远不触发；改用 pointerdown 时间戳判定双击，
   * 三条平台路径全部可靠。
   */
  clickCount: number
}

/** 判定方向的水平位移阈值（物理像素），滤除拖拽起始时刻的抖动/初始跳变。 */
const DRAG_DIRECTION_THRESHOLD = 3
/**
 * 判定「真正开始拖拽」的累计位移阈值（物理像素），对应 dsh-pet 的 DRAG_THRESHOLD
 * （shared/constants.ts:10，逻辑像素 5）：按下后累计位移未达阈值不算拖拽——
 * 单击、双击不进入拖拽、不播放拖动动画（点击回应由双击判定驱动）。
 * 位移按 X/Y 双轴累计（Math.hypot）：垂直拖拽 X 位移可能很小，但不能因此
 * 把拖拽误判为点击。方向采样仍然基于逐次 dx，位移基准独立于方向采样基准。
 */
const DRAG_START_THRESHOLD = 8
/** 双击判定窗口（ms）：两次 pointerdown 间隔小于该值且期间未拖拽，视为双击。 */
const DOUBLE_CLICK_MS = 500
/**
 * 方向停摆阈值：超过此时长没有新的窗口 Moved 事件，方向归零（宠物回到
 * idle/会话动画）。拖拽中短暂停顿（重新抓握）后继续移动会重新产生方向。
 */
const DRAG_DIRECTION_IDLE_TIMEOUT = 350
/**
 * 拖拽会话硬结束阈值：超过此时长没有 Moved 事件即认为原生拖拽已结束。
 * Windows 拖拽结束时 webview 收不到 pointerup（按钮事件被系统模态循环吞掉），
 * 只能靠 Moved 事件流停歇判结束；该阈值同时允许拖拽中较长的停顿后继续。
 */
const DRAG_SESSION_TIMEOUT = 1500

/**
 * 桌宠窗口拖拽 Hook：用 Tauri 原生窗口拖动移动桌宠，并借用窗口 Moved 事件
 * 采样位移方向（原生拖拽期间 webview 收不到 pointermove），供上层切换
 * moving-left / moving-right 动画。
 *
 * 生命周期不依赖 `startDragging()` 的 Promise 时机：
 * - tao 0.35（Windows）用 `PostMessageW(WM_NCLBUTTONDOWN, HTCAPTION)` 发起
 *   原生拖拽后立即返回，Promise 瞬间 resolve —— 它不代表拖拽结束，不能
 *   在 await 后清理拖拽态；
 * - 因此「拖拽进行中」= 按下后 Moved 事件持续到来。「结束」由两级停歇判断：
 *   方向停摆（DRAG_DIRECTION_IDLE_TIMEOUT）只清方向，会话仍存活，停顿后
 *   继续移动方向会恢复；会话硬超时（DRAG_SESSION_TIMEOUT）才真正结束整场
 *   拖拽；pointerup / pointercancel 作兜底。
 */
export function useDrag(dragRef: RefObject<HTMLElement | null>): UseDragResult {
  const draggingRef = useRef(false)
  const engagedRef = useRef(false)
  const moveXRef = useRef<number | undefined>(undefined)
  const moveStartXRef = useRef<number | undefined>(undefined)
  const moveStartYRef = useRef<number | undefined>(undefined)
  const lastDownRef = useRef<number | undefined>(undefined)
  const directionTimerRef = useRef<number | undefined>(undefined)
  const sessionTimerRef = useRef<number | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const [direction, setDirection] = useState<DragDirection | undefined>(undefined)
  const [clickCount, setClickCount] = useState(0)

  useEffect(() => {
    const element = dragRef.current
    if (element === null)
      return undefined
    const appWindow = getCurrentWindow()
    let disposed = false
    let unlisten: (() => void) | undefined

    function clearTimer(ref: { current: number | undefined }): void {
      if (ref.current !== undefined) {
        window.clearTimeout(ref.current)
        ref.current = undefined
      }
    }

    /** 暂停移动：方向与位移基准归零，但拖拽会话保持存活。 */
    function parkDirection(): void {
      moveXRef.current = undefined
      setDirection(undefined)
    }

    function endDrag(): void {
      clearTimer(directionTimerRef)
      clearTimer(sessionTimerRef)
      draggingRef.current = false
      engagedRef.current = false
      setDragging(false)
      moveXRef.current = undefined
      moveStartXRef.current = undefined
      moveStartYRef.current = undefined
      setDirection(undefined)
    }

    /** 新的位移说明拖拽仍在进行：重置两级停歇计时。 */
    function armTimers(): void {
      clearTimer(directionTimerRef)
      clearTimer(sessionTimerRef)
      // 计时器句柄存 ref、由 cleanup 经 clearTimer 统一清理；规则无法追踪 ref 间接清理。
      // eslint-disable-next-line react/web-api-no-leaked-timeout
      directionTimerRef.current = window.setTimeout(parkDirection, DRAG_DIRECTION_IDLE_TIMEOUT)
      // eslint-disable-next-line react/web-api-no-leaked-timeout
      sessionTimerRef.current = window.setTimeout(endDrag, DRAG_SESSION_TIMEOUT)
    }

    async function handlePointerDown(event: PointerEvent): Promise<void> {
      if (event.button !== 0)
        return
      // 双击判定（必须先于 endDrag 读取 engagedRef：它反映「自上次按下以来是否拖拽过」）。
      // 不依赖 DOM dblclick：Windows 原生拖拽的模态循环会吞掉第一次 pointerup，
      // click/dblclick 事件无法合成；这里直接用两次 pointerdown 的间隔 + 未拖拽
      // 判定双击，跨平台可靠。单击/拖拽结束均不会计次（上次会话拖拽过则不算双击）。
      const now = performance.now()
      const isDoubleClick = lastDownRef.current !== undefined
        && now - lastDownRef.current < DOUBLE_CLICK_MS
        && engagedRef.current === false
      lastDownRef.current = now
      // 不调用 preventDefault：取消 pointerdown 会抑制兼容鼠标事件（click/dblclick），
      // 文本选择/触屏滚动已由 CSS（select-none/touch-none）防护。
      // 先清理残留状态（快速连续拖拽时上一轮的空闲计时可能还没到）。
      endDrag()
      draggingRef.current = true
      engagedRef.current = false
      // 参考 dsh-pet：按下仅记录会话，不立即进入拖拽动画（点击不播放拖动浮动），
      // 位移超过 DRAG_START_THRESHOLD 后 onMoved 才把 dragging 置 true。
      setDragging(false)
      moveXRef.current = undefined
      moveStartXRef.current = undefined
      moveStartYRef.current = undefined
      setDirection(undefined)
      if (isDoubleClick)
        setClickCount(count => count + 1)
      // 按下即武装两级停歇计时：Windows 原生拖拽（PostMessageW 模态循环）会吞掉
      // pointerup/pointercancel，若用户按住不移动（零位移按压），onMoved 永不触发、
      // armTimers 永远不会被调用——没有这里的兜底，拖拽会话会残留到下一次按下，
      // 期间任何程序化窗口移动（如设置页 setSize）都会把 Moved 事件当成拖拽输入。
      armTimers()
      void appWindow.startDragging().catch(() => {})
    }

    function handlePointerUp(): void {
      // Windows 原生拖拽结束时 webview 收不到 pointerup（按钮事件被系统模态循环
      // 吞掉），会话由 DRAG_SESSION_TIMEOUT 超时兜底结束。
      endDrag()
    }

    element.addEventListener('pointerdown', handlePointerDown)
    element.addEventListener('pointerup', handlePointerUp)
    element.addEventListener('pointercancel', handlePointerUp)

    void appWindow.onMoved((event) => {
      // 只依赖共享 ref 判断拖拽态：startDragging 的 resolve 时机（平台差异）
      // 与 effect 重建（StrictMode）都不应影响方向采样。
      if (!draggingRef.current)
        return
      armTimers()
      const x = event.payload.x
      const y = event.payload.y
      if (moveStartXRef.current === undefined || moveStartYRef.current === undefined) {
        // 首个 Moved 事件作为位移基准：吞掉 startDragging 可能带来的初始跳变，
        // 以及暂停与恢复之间的坐标不连续。方向采样同样以它起步。
        moveStartXRef.current = x
        moveStartYRef.current = y
        moveXRef.current = x
        return
      }
      if (!engagedRef.current) {
        // 未达拖拽阈值：单击/双击/轻微抖动不算拖拽，不采样方向（基准保持不动）。
        // 位移按 X/Y 双轴累计：垂直拖拽 X 位移较小，不能因此误判为点击。
        if (Math.hypot(x - moveStartXRef.current, y - moveStartYRef.current) < DRAG_START_THRESHOLD)
          return
        engagedRef.current = true
        setDragging(true)
      }
      if (moveXRef.current === undefined) {
        // 停顿（parkDirection）后恢复移动：重新建立方向采样基准。
        moveXRef.current = x
        return
      }
      const dx = x - moveXRef.current
      moveXRef.current = x
      if (Math.abs(dx) >= DRAG_DIRECTION_THRESHOLD)
        setDirection(dx > 0 ? 'right' : 'left')
    }).then((dispose) => {
      if (disposed)
        dispose()
      else
        unlisten = dispose
    }).catch(() => {})

    return () => {
      disposed = true
      unlisten?.()
      element.removeEventListener('pointerdown', handlePointerDown)
      element.removeEventListener('pointerup', handlePointerUp)
      element.removeEventListener('pointercancel', handlePointerUp)
      clearTimer(directionTimerRef)
      clearTimer(sessionTimerRef)
      draggingRef.current = false
      engagedRef.current = false
      setDragging(false)
      moveXRef.current = undefined
      moveStartXRef.current = undefined
      moveStartYRef.current = undefined
      setDirection(undefined)
    }
  }, [dragRef])

  return { dragging, direction, clickCount }
}
