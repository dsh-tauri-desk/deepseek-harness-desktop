/**
 * host/service/session-record.ts — 在宿主边界归一化「活会话」与查询快照。
 *
 * 逐字移植 dsh-plugin-message-edit 的 lib/session-record.js（MIT © SpookySandwich）。
 * 不同 DSH 版本把会话历史暴露在 `snapshotEvents()` / `events` 上，继承边界也从
 * `header.seedLength` 搬到创建选项 `inheritedEventCount`；这里收敛成一个稳定快照。
 */

import type { HostContext, SessionRecordLike } from '../types'

/** 读会话事件（活会话走 `snapshotEvents()`，查询快照走 `events`）。 */
export function sessionEvents(session: unknown): readonly Record<string, unknown>[] {
  const candidate = session as { snapshotEvents?: () => unknown, events?: unknown } | undefined
  const events = typeof candidate?.snapshotEvents === 'function'
    ? candidate.snapshotEvents()
    : candidate?.events
  if (!Array.isArray(events))
    throw new Error('无法读取 DSH 会话历史：需要 snapshotEvents() 或 events 数组，请检查插件与 DSH 的版本兼容性。')
  return events as readonly Record<string, unknown>[]
}

/** 不物化现代活会话日志的前提下读追加长度。 */
export function sessionEventCount(session: unknown): number {
  const candidate = session as { snapshotEvents?: unknown, seq?: unknown } | undefined
  return typeof candidate?.snapshotEvents === 'function'
    && Number.isSafeInteger(candidate.seq)
    && (candidate.seq as number) >= 0
    ? candidate.seq as number
    : sessionEvents(session).length
}

/** 为一次操作里的全部规划 / 祖先 / seed 读取取同一个稳定快照。 */
export function sessionRecord(session: unknown): SessionRecordLike {
  const events = sessionEvents(session)
  const candidate = session as { header?: { id?: unknown }, session?: { id?: unknown } } | undefined
  const header = (candidate?.header ?? candidate?.session) as Record<string, unknown> | undefined
  if (header === undefined || typeof header.id !== 'string')
    throw new Error('无法读取 DSH 会话头：缺少会话标识。')

  const rawInherited = (session as { inheritedEventCount?: unknown })?.inheritedEventCount
    ?? header.seedLength
    ?? (header.isSeeded === true ? undefined : 0)
  if (!Number.isSafeInteger(rawInherited) || (rawInherited as number) < 0 || (rawInherited as number) > events.length)
    throw new Error(`会话 ${header.id} 的继承事件边界无效，无法安全创建分支。`)

  return {
    id: header.id,
    header: header as unknown as SessionRecordLike['header'],
    events: events as unknown as SessionRecordLike['events'],
    inheritedEventCount: rawInherited as number,
  }
}

/** DSH 把继承边界从 header.seedLength 搬到了创建选项上。 */
export function branchSeedOptions(source: SessionRecordLike, inheritedEventCount: number): {
  inheritedEventCount?: number
  meta: Record<string, unknown>
} {
  return typeof source.header.isSeeded === 'boolean'
    ? { inheritedEventCount, meta: { isSeeded: true } }
    : { meta: { seedLength: inheritedEventCount } }
}

/** 会话身份（活会话 / 快照两种形态都认）。 */
export function sessionRecordId(session: any): string | undefined {
  return session?.header?.id ?? session?.id
}

/** 从宿主 ctx 读一条会话的稳定记录（live 优先，其次 sessionQuery）。 */
export async function loadSessionRecord(ctx: HostContext, sessionId: string): Promise<SessionRecordLike> {
  const live = ctx.sessions.get(sessionId)
  return sessionRecord(live ?? await ctx.sessionQuery.readSession(sessionId))
}
