import type { LiveSnapshot, SnapshotStore } from '../types'

/** 一个正在进行中的 turn 的捕获状态。 */
export interface ActiveTurn {
  sessionId: string
  turn: number
  workspaceRoot: string | null
  store: SnapshotStore | null
  beforeCommit: string | null
  /** 本 turn 不可撤销的原因（资格拒绝/快照失败）。 */
  skippedReason: string | null
  /** 运行中实时读数（before 快照成功后开始轮询更新；`active` 由读取面补上）。 */
  live: Omit<LiveSnapshot, 'active'> | null
  liveTimer: ReturnType<typeof setInterval> | null
  /** 上一次实时刷新是否仍在飞（防止慢仓库堆积轮询）。 */
  liveBusy: boolean
  /**
   * 读数世代：每次作废（停表/重置）自增。在飞的 `git diff` 落地时世代已变即丢弃结果，
   * 否则一次晚到的刷新会把刚被重置掉的读数复活。
   */
  liveEpoch: number
  /** 本 turn 应用的排除路径（超限文件 + 嵌套仓库），捕获与实时读数共用。 */
  exclusions: string[]
  /** 本 turn 实际被跳过的嵌套仓库。 */
  nestedDirs: string[]
  /** before 快照时的快照仓代数（写进账本，供撤销判定过期）。 */
  generation: string | null
}

/** 正在执行的 before 快照（结算路径要先等它落地）。 */
export interface BeginningTurn {
  sessionId: string
  turn: number
  task: Promise<void>
}

/** 日志面（宿主 logger 的最小契约；缺失时静默）。 */
export interface CaptureLogger {
  warn?: (message: string) => void
}
