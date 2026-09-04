import type { PetActivity, PetAnimation, PetFacing } from './state'

export interface PetArbitrationInput {
  sessionActivity: PetActivity
  interactionActivity: PetAnimation | null
  draggingActivity: Extract<PetActivity, 'moving-left' | 'moving-right'> | null
}

/**
 * 统一桌宠动作优先级：拖动动画只在「正在拖动」期间覆盖会话状态；
 * 拖动一旦结束 draggingActivity 变回 null，随后按 session → interaction → idle 回落，
 * 从而在 waiting/running/review/failed 之后仍恢复原会话动画，绝不硬编码 idle。
 * 会话状态依旧压过一次性交互（wave/bubble/turn），避免低优先级回调覆盖工作状态。
 */
export function resolvePetActivity(input: PetArbitrationInput): PetAnimation {
  if (input.draggingActivity !== null)
    return input.draggingActivity
  if (input.sessionActivity !== 'idle')
    return input.sessionActivity
  return input.interactionActivity ?? 'idle'
}

/** 一次性交互只在仍处于相同 generation 时允许提交完成。 */
export function isCurrentPetGeneration(current: number, expected: number): boolean {
  return current === expected
}

/**
 * 拖动方向由相邻物理窗口位置决定；当两次位置的位移小于 jitter 时保持当前方向，
 * 避免光标/窗口微小抖动让 facing 反复横跳。
 */
export function dragFacing(previousX: number, nextX: number, current: PetFacing, jitter = 0): PetFacing {
  if (nextX === previousX)
    return current
  if (Math.abs(nextX - previousX) < jitter)
    return current
  return nextX < previousX ? 'left' : 'right'
}
