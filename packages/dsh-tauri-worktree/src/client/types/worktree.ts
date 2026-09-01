/** types/worktree.ts — 工作树领域类型（会话状态 / RPC 载荷）。 */

/** 工作树处理阶段（会话处理状态与日志展示的三阶段）。 */
export type WorktreePhase = 'idle' | 'creating' | 'created' | 'thinking' | 'error'

/** 某会话绑定的工作树状态。 */
export interface WorktreeSessionState {
  /** 模式：local（本地）| pending（下一条消息新建）| worktree（隔离工作树）。 */
  mode: 'local' | 'pending' | 'worktree'
  /** 会话工作目录是否位于 git 仓库内（非 git 目录强制 local 且隐藏模式选择器）。 */
  isGit: boolean
  /** 处理阶段（本地会话恒为 idle）。 */
  phase: WorktreePhase
  /** 阶段 1 的加载提示（正在准备工作区 → 正在检出文件），随创建推进。 */
  loadingLabel: string
  /** 阶段 2 的创建日志（点击查看）。 */
  log: string[]
  /** 工作树标识 [hash]/[dirname]（弹窗的「当前关联路径」）。 */
  worktreeKey: string
  /** 工作树绝对路径。 */
  worktreePath: string
  /** 项目（目标仓库）绝对路径。 */
  projectPath: string
  /** 创建工作树前所在的源会话（用于侧边栏归组与完成后返回）。 */
  sourceSessionId: string
  /** 检出弹窗分支名输入框当前值。 */
  branchName: string
  /** 检出弹窗是否打开。 */
  checkoutOpen: boolean
  /** 放弃弹窗是否打开。 */
  abandonOpen: boolean
  /** 最近一次 API 错误（展示用）。 */
  error: string
}

/** 全局共享状态源（模块级单例；插件重载时随 bundle 重建，可接受）。 */
export interface WorktreeUiState {
  /** 按会话 id 缓存的工作树状态。 */
  bySession: Record<string, WorktreeSessionState>
}

export interface WorktreeStatus {
  mode: 'local' | 'worktree'
  worktreeKey?: string
  worktreePath?: string
  projectPath?: string
  hash?: string
  dirname?: string
  sourceSessionId?: string
  log?: string[]
  /**
   * 会话工作目录是否位于 git 仓库内（非 git 目录时客户端应强制本地并隐藏模式选择器）。
   * null 表示宿主尚未解析出该会话（新建/启动竞态）：客户端保持默认 git 假设、不落库，
   * 稍后重试，绝不据此隐藏工作树 UI。
   */
  isGit?: boolean | null
}

export interface WorktreeCreate {
  ok: boolean
  hash: string
  dirname: string
  worktreeKey: string
  worktreePath: string
  projectPath: string
  sourceSessionId: string
  log: string[]
  existed: boolean
}

/** 检出本地：把工作树改动带回本地分支，解除绑定，恢复本地会话。 */
export interface WorktreeCheckout {
  ok: boolean
  branch: string
  projectPath?: string
  /**
   * 检出后带回本地的新会话 id（继承工作树会话完整对话历史，cwd 指向本地项目）。
   * 缺失表示继承会话创建失败（宿主返回 warning）。
   */
  targetSessionId?: string
  warning?: string
}
