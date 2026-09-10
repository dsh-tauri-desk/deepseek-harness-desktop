/**
 * host/types/index.ts — 宿主侧共享类型。
 *
 * HostContext 保持结构化 any（与 dsh-tauri-worktree 同口径）：宿主服务的完整类型由
 * 各内核版本自带，本插件只消费已核实存在的成员，避免把某一版的类型钉进构建。
 */

export type HostContext = any

export type JsonBody = Record<string, unknown>

/**
 * 一次 git 子进程的结果；捕获/撤销路径从不抛异常，失败一律走该联合。
 *
 * 失败分支同样带 `out`：`git check-ignore` 这类命令**用退出码表达否定答案**
 * （exit 1 = 没有路径被忽略），stdout 才是真正的结果，丢弃它会把「没有命中」
 * 误判成「命令失败」。
 */
export type GitResult
  = | { ok: true, out: string }
    | { ok: false, error: string, out: string, code?: string }

/** 单个工作区私有快照仓的定位信息。 */
export interface SnapshotStore {
  /** 会话工作区（Git worktree 根）。 */
  worktree: string
  /** 私有快照仓目录（`$DSH_HOME/<feature>/workspaces/<hash>.git`）。 */
  gitDir: string
  /** 源仓库 common dir（资格探测时一并解析，供 info/exclude 同步复用）。 */
  commonDir?: string | null
  /** 快照仓代数：整仓重建或被删后轮换，账本记录据此判定「快照已过期」。 */
  generation?: string
  /** 最近一次整仓重建的原因（诊断日志用）。 */
  rebuiltReason?: string
}

/** 一次路径安全校验的结果。 */
export type PathSafety = { ok: true } | { ok: false, reason: string }

/** 单次捕获的用量上限（默认取宿主常量；宿主插件行配置/测试可覆盖）。 */
export interface CaptureLimits {
  /** 单个文件超过此值即排除并标注。 */
  maxFileBytes: number
  /** 聚合字节上限；超过即排除最大文件重试，仍超则记 unavailable。 */
  maxSnapshotBytes: number
  /** 文件数上限；超过记 unavailable。 */
  maxFiles: number
}

/** 一次快照捕获的可选项。 */
export interface CaptureOptions {
  /** 已持久化的排除路径（超限文件 / 嵌套仓库），本轮直接带上以免重付捕获代价。 */
  exclude?: readonly string[]
  /** 本轮已知的嵌套仓库目录（缺省则现场有界扫描）。 */
  nestedDirs?: readonly string[]
  /** 用量上限覆盖（缺省用宿主常量）。 */
  limits?: Partial<CaptureLimits>
}

/** 一次快照捕获的结果。 */
export type CaptureResult
  = | {
    ok: true
    commit: string
    /** 因超过单文件上限而未纳入快照的路径（明确标注，绝不静默漏掉）。 */
    skippedOversized: string[]
    /** 被跳过的嵌套 Git 仓库路径（内容不受撤销保护）。 */
    skippedNestedRepos: string[]
    /** 本轮新学到的排除项，调用方持久化后后续 turn 不必再重捕。 */
    learnedExclusions: string[]
  }
  | { ok: false, reason: string }

/** 工作区资格探测结果。 */
export type WorkspaceProbe
  = | { ok: true, root: string, commonDir: string }
    | { ok: false, reason: string }

/** 一个 turn 内的单文件差异。 */
export interface TurnFileChange {
  /** 相对 worktree 根的路径。 */
  path: string
  /** A=本 turn 新增，M=修改，D=删除。 */
  status: 'A' | 'M' | 'D'
  /** 文本行新增数；二进制为 null。 */
  insertions: number | null
  /** 文本行删除数；二进制为 null。 */
  deletions: number | null
  /** 是否为二进制差异。 */
  binary: boolean
}

/** 一个 turn 的变更记录（账本行）。 */
export interface TurnRecord {
  turn: number
  beforeRef: string
  afterRef: string
  files: TurnFileChange[]
  insertions: number
  deletions: number
  createdAt: number
  /** 已撤销时间戳；null/缺省表示未撤销。 */
  undoneAt?: number | null
  /** 不可用原因（超限/失败/过期）；非空表示该 turn 无可用快照。 */
  unavailable?: string | null
  /** 捕获时的快照仓代数；缺失表示记录来自旧版本，只能按 refs 判定是否失效。 */
  generation?: string | null
  /** 因超过单文件上限而被排除的文件（明确标注，绝不静默漏掉）。 */
  skippedOversized?: string[]
  /** 被跳过的嵌套 Git 仓库路径：gitlink 内容无法被撤销（明确标注）。 */
  skippedNestedRepos?: string[]
  /** 过期时间戳；非空表示该轮已不可撤销（审计行与计数保留）。 */
  expiredAt?: number | null
}

/** 每会话账本文件的结构。 */
export interface SessionLedger {
  version: number
  sessionId: string
  /** 已解析的 worktree 根；非 Git 会话为 null。 */
  workspaceRoot: string | null
  /** 会话 cwd 是否位于 Git worktree 内。 */
  isGit: boolean
  unavailableReason: string | null
  turns: TurnRecord[]
}

/** 运行中实时读数的线协议形态（客户端「运行中」提示条）。 */
export interface LiveSnapshot {
  /** 是否有正在进行的 turn（false 时其余字段为占位 0）。 */
  active: boolean
  /** 正在进行的 turn 号；无活动 turn 时为 null。 */
  turn: number | null
  fileCount: number
  insertions: number
  deletions: number
}

/** 撤销前的冲突明细。 */
export interface UndoConflict {
  path: string
  /** 冲突原因（人类可读，用于卡片展示）。 */
  reason: string
}

/** 撤销结果。 */
export type UndoOutcome
  = | { ok: true, restored: string[], removed: string[], failed: Array<{ path: string, reason: string }> }
    | { ok: false, code: number, error: string, conflicts?: UndoConflict[] }

/** 客户端 summary 路由的载荷（turns 为账本记录的摘要投影）。 */
export interface SummaryPayload {
  sessionId: string
  isGit: boolean
  workspaceRoot: string | null
  unavailableReason: string | null
  turns: Array<{
    turn: number
    fileCount: number
    insertions: number
    deletions: number
    undoneAt: number | null
    unavailable: string | null
    /**
     * 该轮是否建立过 before/after 快照（refs 是否留下）。
     *
     * 与 `unavailable` 配合区分两种失败：连基线都没有 = 这一轮从没有过可撤销的东西
     * （客户端对通用失败保持沉默）；基线在而 after 结算失败 = 承诺过的撤销落空了
     * （客户端必须告警）。
     */
    hasBaseline: boolean
    truncated: boolean
    files: TurnFileChange[]
    /** 因超过单文件上限而未纳入快照的路径（不在撤销范围内）。 */
    skippedOversized: string[]
    /** 被跳过的嵌套 Git 仓库路径（其内部改动不受撤销保护）。 */
    skippedNestedRepos: string[]
  }>
}
