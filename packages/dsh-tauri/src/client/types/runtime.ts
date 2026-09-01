import type {
  ISessions,
  SessionListState,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces,
  WorkspaceId,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'

/** Real runtime slot registry contract (alpha: ui-renderer owns the Service layer). */
export type { SlotRegistry }
/** Real runtime session list state and summary contracts. */
export type { SessionListState, SessionSummary }
/** Real runtime workspace identifier contract. */
export type { WorkspaceId }
/** Real runtime outward session/workspace faces. */
export type { ISessions, IWorkspaces }

/** Runtime session service projection used by legacy plugin helpers. */
export interface SessionsRuntime {
  list: {
    getSnapshot: () => unknown
    subscribe: (listener: () => void) => () => void
  }
}

/** Runtime workspace service projection used by legacy plugin helpers. */
export interface WorkspacesRuntime {
  list: {
    getSnapshot: () => unknown
    subscribe: (listener: () => void) => () => void
  }
  startSession: (workspaceId?: WorkspaceId) => void
}
