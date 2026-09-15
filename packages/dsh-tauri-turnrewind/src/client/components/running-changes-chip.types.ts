/**
 * 运行中提示条 props：input.dock 的 owner 份额（InputZone）+ 注册 inject 份额。
 * owner 份额里的 `session` 是点快照的会话快照，`running` 决定是否轮询实时读数。
 */
export interface RunningChangesChipProps {
  session?: { running?: boolean } | undefined
  sessionId?: string | undefined
}
