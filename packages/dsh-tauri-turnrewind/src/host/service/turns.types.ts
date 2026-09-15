/** 一次账本变更需要调用方配合的副作用。 */
export interface LedgerMutation {
  /** 被标记过期 / 被硬上限丢弃的 turn 所对应的 refs。 */
  refsToDelete: string[]
}

/** 工作区资格结论（非 Git / 被守卫拒绝也要留痕，供客户端呈现不可用态）。 */
export interface WorkspaceState {
  workspaceRoot: string | null
  isGit: boolean
  unavailableReason: string | null
}
