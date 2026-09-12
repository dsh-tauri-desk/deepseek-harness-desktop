import { useEventListener, useTimeoutFn } from '@reause/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useRef, useState } from 'react'

/** 拖拽的水平方向。 */
type DragDirection = 'left' | 'right'

export interface UseDragResult {
  /** 原生拖拽会话进行中（按下后位移超过阈值才算，结束/超时后为 false）。 */
  dragging: boolean
  /** 当前拖拽方向；未拖拽、位移不足或拖拽停顿时为 undefined。 */
  direction: DragDirection | undefined
}

/** 判定方向的水平位移阈值（物理像素），滤除拖拽起始时刻的抖动/初始跳变。 */
const DRAG_DIRECTION_THRESHOLD = 3
/**
 * 判定「真正开始拖拽」的累计位移阈值（物理像素，逻辑像素 5 的同量级）：按下后累计
 * 位移未达阈值不算拖拽 —— 单击不进入拖拽、不播放拖动动画（点击回应由 `<Pet>` 内置
 * 的双击判定驱动）。位移按 X/Y 双轴累计（Math.hypot）：垂直拖拽 X 位移可能很小，
 * 不能因此把拖拽误判为点击。
 */
const DRAG_START_THRESHOLD = 8
/**
 * 方向停摆阈值：超过此时长没有新的窗口 Moved 事件，方向归零（宠物回到 idle/会话动画）。
 * 拖拽中短暂停顿（重新抓握）后继续移动会重新产生方向。
 */
const DRAG_DIRECTION_IDLE_TIMEOUT = 350
/**
 * 拖拽会话硬结束阈值：超过此时长没有 Moved 事件即认为原生拖拽已结束。
 * Windows 拖拽结束时 webview 收不到 pointerup（按钮事件被系统模态循环吞掉），
 * 只能靠 Moved 事件流停歇判结束；该阈值同时允许拖拽中较长的停顿后继续。
 */
const DRAG_SESSION_TIMEOUT = 1500

/**
 * 桌宠窗口拖拽：用 Tauri 原生窗口拖动移动桌宠，并借用窗口 `Moved` 事件采样位移
 * 方向（原生拖拽期间 webview 收不到 pointermove），供上层切换 moving-left/right。
 *
 * # 为什么监听 window 而不是命中箱
 *
 * 桌宠窗口平时按命中箱矩形对光标穿透（`useOmitIgnoreCursorEvents`），能到达页面的
 * 指针事件本来就只发生在命中箱附近，因此 `window` 级监听与命中箱监听效果等价；而
 * reause 的 `useEventListener` 在渲染期解析 ref 目标，命中箱由 `<Pet>` 在提交阶段
 * 才挂上，用 ref 当目标会漏绑定。
 *
 * # 生命周期不依赖 `startDragging()` 的 Promise 时机
 *
 * tao（Windows）用 `PostMessageW(WM_NCLBUTTONDOWN, HTCAPTION)` 发起原生拖拽后立即
 * 返回，Promise 瞬间 resolve —— 它不代表拖拽结束，不能在 await 后清理拖拽态；
 * 因此「拖拽进行中」= 按下后 Moved 事件持续到来，由两级停歇判断收尾（见上方两个
 * 超时常量），pointerup / pointercancel 仅作兜底。
 */
export function useDrag(): UseDragResult {
  const activeRef = useRef(false)
  const engagedRef = useRef(false)
  const originRef = useRef<{ x: number, y: number } | undefined>(undefined)
  const moveXRef = useRef<number | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const [direction, setDirection] = useState<DragDirection | undefined>(undefined)

  // reause 的 `useTimeoutFn` 缺省在挂载时就开始计时，这里必须 `immediate: false`：
  // 只有窗口 Moved 事件才重新 `start()`（等价于「重置计时」）。回调始终读取最新闭包，
  // 且只操作 ref 与 setState，因此不需要额外的 clearTimeout 记账。
  const { start: armDirectionTimer, stop: stopDirectionTimer } = useTimeoutFn(
    parkDirection,
    DRAG_DIRECTION_IDLE_TIMEOUT,
    { immediate: false },
  )
  const { start: armSessionTimer, stop: stopSessionTimer } = useTimeoutFn(
    endDrag,
    DRAG_SESSION_TIMEOUT,
    { immediate: false },
  )

  /** 暂停移动：方向与位移基准归零，但拖拽会话保持存活。 */
  function parkDirection(): void {
    moveXRef.current = undefined
    setDirection(undefined)
  }

  function endDrag(): void {
    activeRef.current = false
    engagedRef.current = false
    originRef.current = undefined
    moveXRef.current = undefined
    stopDirectionTimer()
    stopSessionTimer()
    setDragging(false)
    setDirection(undefined)
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0)
      return
    // 不调用 preventDefault：取消 pointerdown 会抑制兼容鼠标事件，文本选择/触屏滚动
    // 已由样式（select-none / touch-none）防护。先清理残留状态（快速连续拖拽时上一轮
    // 的空闲计时可能还没到）。
    endDrag()
    activeRef.current = true
    // 参考 dsh-pet：按下仅记录会话，不立即进入拖拽动画（单击不播放拖动浮动），
    // 位移超过 DRAG_START_THRESHOLD 后才把 dragging 置 true。
    void getCurrentWindow().startDragging().catch(() => {})
  }

  function handlePointerUp(): void {
    endDrag()
  }

  useEventListener('pointerdown', handlePointerDown)
  useEventListener('pointerup', handlePointerUp)
  useEventListener('pointercancel', handlePointerUp)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWindow().onMoved((event) => {
      // 只依赖共享 ref 判断拖拽态：startDragging 的 resolve 时机（平台差异）与
      // effect 重建（StrictMode）都不应影响方向采样。
      if (!activeRef.current)
        return
      // 新的位移说明拖拽仍在进行：重置两级停歇计时。
      armDirectionTimer()
      armSessionTimer()
      const { x, y } = event.payload
      const origin = originRef.current
      if (origin === undefined) {
        // 首个 Moved 事件作为位移基准：吞掉 startDragging 可能带来的初始跳变，
        // 以及暂停与恢复之间的坐标不连续。方向采样同样以它起步。
        originRef.current = { x, y }
        moveXRef.current = x
        return
      }
      if (!engagedRef.current) {
        // 未达拖拽阈值：单击/轻微抖动不算拖拽，不采样方向（基准保持不动）。
        if (Math.hypot(x - origin.x, y - origin.y) < DRAG_START_THRESHOLD)
          return
        engagedRef.current = true
        setDragging(true)
      }
      const lastX = moveXRef.current
      moveXRef.current = x
      if (lastX === undefined) {
        // 停顿（parkDirection）后恢复移动：重新建立方向采样基准。
        return
      }
      const dx = x - lastX
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
    }
  }, [armDirectionTimer, armSessionTimer])

  return { dragging, direction }
}
