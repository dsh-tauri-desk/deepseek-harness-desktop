export interface WorktreeBindingSummary {
  sessionId: string
  sourceSessionId: string
  hash: string
  dirname: string
  worktreeKey: string
  worktreePath: string
  projectPath: string
  log: string[]
}

export interface WorktreeDiscardJobSummary {
  sessionId: string
  jobId: string
  state: 'deleting' | 'failed'
  error?: string
  worktreeKey: string
  worktreePath?: string
}

export interface WorktreeBindings {
  bindings: WorktreeBindingSummary[]
  jobs: WorktreeDiscardJobSummary[]
}

export interface WorktreeDiscard {
  ok: boolean
  jobId?: string
  error?: string
}

export interface WorktreeStatus {
  mode: 'local' | 'worktree' | 'deleting' | 'failed'
  jobId?: string
  error?: string
  worktreeKey?: string
  worktreePath?: string
  projectPath?: string
  hash?: string
  dirname?: string
  sourceSessionId?: string
  log?: string[]
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
  inherited: boolean
}

export interface WorktreeCheckout {
  ok: boolean
  branch: string
  projectPath?: string
  targetSessionId?: string
  warning?: string
}

export interface GetStatusQuery {
  sessionId: string
  jobId?: string
}

export interface PostCreateBody {
  sessionId: string
  sourceSessionId: string
  inherit: boolean
}

export interface PostAttachBody {
  sessionId: string
}

export interface PostCheckoutBody {
  sessionId: string
  worktreeHashDirname: string
  branchName: string
}

export interface PostDiscardBody {
  sessionId: string
  worktreeHashDirname: string
}
