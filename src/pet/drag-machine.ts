// 桌宠拖动状态机的纯逻辑：用窗口物理位置增量决定方向，与 WebView 指针事件解耦。

import type { PetFacing } from './state'
import { dragFacing } from './arbiter'

/**
 * 拖动生命周期：idle（无拖动）→ starting（已按下、等待窗口真正移动）
 * → dragging（窗口已越过抖动阈值，方向动画应播放）→ ending（松开、待复位）。
 */
export type DragPhase = 'idle' | 'starting' | 'dragging' | 'ending'

// 方向判定阈值：窗口每次位移小于该物理像素数时不改变方向，避免 facing 闪烁。
export const DRAG_JITTER_PX = 4
// 原生拖动期间 onMoved/指针事件可能不稳定，按下后以该间隔轮询窗口物理位置作为兜底。
export const DRAG_SAMPLE_INTERVAL_MS = 40

export interface DragMachine {
  phase: DragPhase
  facing: PetFacing
  /** 上一次已提交方向的窗口 X 坐标；用于累计抖动，避免慢速拖动因单次增量过小而不更新。 */
  anchorX: number | null
}

export function createDragMachine(): DragMachine {
  return { phase: 'idle', facing: 'left', anchorX: null }
}

/** 按下时进入 starting；朝向保留当前值，方向待窗口真正移动后再定。 */
export function beginDrag(facing: PetFacing): DragMachine {
  return { phase: 'starting', facing, anchorX: null }
}

/**
 * 窗口物理位置采样：从 anchorX 起累计位移，越过抖动阈值才提交方向并进入 dragging。
 * 未越过阈值时保留当前方向且不更新 anchorX，从而让慢速连续拖动也能在累计后正确转向。
 */
export function dragSample(current: DragMachine, x: number): DragMachine {
  if (current.phase !== 'starting' && current.phase !== 'dragging')
    return current
  if (current.anchorX === null)
    return { ...current, anchorX: x }
  const delta = x - current.anchorX
  if (Math.abs(delta) < DRAG_JITTER_PX)
    return current
  return {
    phase: 'dragging',
    facing: dragFacing(current.anchorX, x, current.facing, DRAG_JITTER_PX),
    anchorX: x,
  }
}

/** 松开/取消：进入 ending，表示一次拖动（或点击）交互已结束。 */
export function endDrag(current: DragMachine): DragMachine {
  return { ...current, phase: 'ending' }
}

/** 复位到初始空闲态。 */
export function resetDrag(): DragMachine {
  return createDragMachine()
}

/** 是否处于「启动中或拖动中」（onMoved/轮询 应当继续采样）。 */
export function isDragActive(machine: DragMachine): boolean {
  return machine.phase === 'starting' || machine.phase === 'dragging'
}

/** 是否已经真实越过阈值拖动（区分拖拽与点击）。 */
export function hasDragged(machine: DragMachine): boolean {
  return machine.phase === 'dragging'
}
