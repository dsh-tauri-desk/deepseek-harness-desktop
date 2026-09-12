import type { WorktreeBindings, WorktreeCheckout, WorktreeCreate, WorktreeDiscard, WorktreeStatus } from '../types'

export type { WorktreeBindings, WorktreeCheckout, WorktreeCreate, WorktreeDiscard, WorktreeStatus }

/** GET /status 查询参数。 */
export interface GetStatusQuery {
  sessionId: string
  jobId?: string
}

/** POST /create 请求体。 */
export interface PostCreateBody {
  sessionId: string
  sourceSessionId: string
  inherit: boolean
}

/** POST /attach 请求体。 */
export interface PostAttachBody {
  sessionId: string
}

/** POST /checkout 请求体。 */
export interface PostCheckoutBody {
  sessionId: string
  worktreeHashDirname: string
  branchName: string
}

/** POST /discard 请求体。 */
export interface PostDiscardBody {
  sessionId: string
  worktreeHashDirname: string
}
