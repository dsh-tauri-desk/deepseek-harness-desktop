import type { ClientContext } from 'dsh-tauri/client'
import type {
  PetObservable,
  PetRuntimeContext,
  PetSessionActivity,
  PetSessionEvent,
  PetSessionSnapshot,
  PetSessionStatus,
} from '../types'
import type { SessionStatusRecord } from '../utils/session-status'
import { compat, createLifecycleController } from 'dsh-tauri/client'
import { PET_ACTIVITY_EFFECT } from '../constants'
import { text } from '../locales'
import {
  describePending,
  describeSession,
  mapPetActivity,
  phaseActivity,
  sessionTitle,
} from '../utils/activity'
import { createSessionStatus, reduceSessionEvent } from '../utils/session-status'
import { setPetSessions } from './pet'

function activityLabel(activity: PetSessionActivity): string {
  switch (activity) {
    case 'failed':
      return text('activityFailed')
    case 'review':
      return text('activityReview')
    case 'running':
      return text('activityRunning')
    case 'waiting':
      return text('activityWaiting')
    case 'idle':
    default:
      return text('activityIdle')
  }
}

function resolvePendingSource(ctx: ClientContext): PetObservable<ReadonlyMap<string, unknown>> | undefined {
  const lookup = ctx as unknown as { get?: (name: string) => unknown }
  try {
    const service = lookup.get?.('uiSession') as PetRuntimeContext['uiSession'] | undefined
    return service?.pendingInteractions
  }
  catch {
    return undefined
  }
}

function pendingKindOf(value: unknown): string | undefined {
  if (value && typeof value === 'object')
    return typeof (value as { kind?: unknown }).kind === 'string' ? (value as { kind: string }).kind : undefined
  return typeof value === 'string' ? value : undefined
}

function resolveText(key: string): string {
  return text(key as Parameters<typeof text>[0])
}

/**
 * 从会话事件窗口把新事件回放进归约器。窗口是「完整事件窗口」快照，因此每次
 * 推送都按序喂入；`reduceSessionEvent` 会按 seq 去重，这里再按 `lastSeq` 提前
 * 跳过已消费事件，避免长会话反复重放整段窗口（O(n²) → O(n)）。
 */
function replayEventWindow(record: SessionStatusRecord, window: { entries?: PetSessionEvent[] }): void {
  const entries = Array.isArray(window.entries) ? window.entries : []
  for (const event of entries) {
    const seq = Number(event?.seq ?? 0)
    if (Number.isFinite(seq) && seq <= record.lastSeq)
      continue
    reduceSessionEvent(record, event)
  }
}

/** Mirror every known Codex session into one native snapshot; the pet owns visual arbitration. */
export function installPetActivity(ctx: ClientContext): void {
  ctx.effect(() => {
    const runtime = compat(ctx) as unknown as PetRuntimeContext
    const controller = createLifecycleController()
    const pendingSource = resolvePendingSource(ctx)
    const snapshots = new Map<string, PetSessionSnapshot | undefined>()
    const reducerStates = new Map<string, SessionStatusRecord>()
    const disposers = new Map<string, () => void>()
    let lastPayload = ''
    let disposed = false
    let pushChain: Promise<void> = Promise.resolve()

    function push(): void {
      const list = runtime.sessions.list.getSnapshot()
      const sessions: PetSessionStatus[] = []
      for (const id of list.ids) {
        const summary = list.byId?.[id]
        const snapshot = snapshots.get(id)
        const pending = pendingSource?.getSnapshot().get(id) ?? summary?.pendingInteraction
        const record = reducerStates.get(id)

        let activity: PetSessionActivity
        if (pending !== undefined)
          activity = 'waiting'
        else if (record !== undefined && record.phase !== 'idle' && record.phase !== 'stopped')
          activity = phaseActivity(record)
        else
          activity = mapPetActivity(summary, snapshot, pending)

        // 会话真正空闲（未运行、未完成、无报错、无待决策）时不弹 Toast。
        if (activity === 'idle')
          continue

        const title = sessionTitle(summary?.title ?? summary?.displayTitle, activityLabel(activity))
        let description: string
        if (pending !== undefined)
          description = describePending(pendingKindOf(pending), resolveText)
        else if (record !== undefined && record.phase !== 'idle')
          description = describeSession(record, resolveText)
        else
          description = resolveText('activityRunning')

        sessions.push({ id, activity, bubble: title, description })
      }
      sessions.sort((left, right) => {
        const current = runtime.sessions.list.getSnapshot().current
        if (left.id === current)
          return -1
        if (right.id === current)
          return 1
        return left.id.localeCompare(right.id)
      })
      const payload = JSON.stringify(sessions)
      if (payload === lastPayload)
        return
      lastPayload = payload
      pushChain = pushChain.then(async () => {
        if (disposed)
          return
        try {
          await setPetSessions(sessions)
        }
        catch (error) {
          console.error('[dsh-tauri-pet] update pet sessions failed:', error)
        }
      })
    }

    /** 为单条会话绑定快照/事件订阅；返回组合卸载函数。 */
    function bindSession(id: string): void {
      const source = runtime.sessions.binding?.(id)
      if (source === undefined)
        return
      const disposeList: Array<() => void> = []

      const sessionStore = source.session
      if (sessionStore !== undefined) {
        snapshots.set(id, sessionStore.getSnapshot())
        disposeList.push(sessionStore.subscribe(() => {
          snapshots.set(id, sessionStore.getSnapshot())
          push()
        }))
      }

      const eventSource = source.eventSource
      if (eventSource !== undefined) {
        const record = createSessionStatus()
        reducerStates.set(id, record)
        replayEventWindow(record, eventSource.getSnapshot())
        disposeList.push(eventSource.subscribe(() => {
          replayEventWindow(record, eventSource.getSnapshot())
          push()
        }))
      }

      disposers.set(
        id,
        () => {
          for (const dispose of disposeList)
            dispose()
        },
      )
    }

    function syncSessions(): void {
      const ids = new Set(runtime.sessions.list.getSnapshot().ids)
      for (const [id, dispose] of disposers) {
        if (!ids.has(id)) {
          dispose()
          disposers.delete(id)
          snapshots.delete(id)
          reducerStates.delete(id)
        }
      }
      for (const id of ids) {
        if (disposers.has(id))
          continue
        bindSession(id)
      }
      push()
    }

    controller.add(runtime.sessions.list.subscribe(syncSessions))
    if (pendingSource !== undefined) {
      controller.add(pendingSource.subscribe(() => {
        syncSessions()
        push()
      }))
    }
    const bindingRetryTimer = globalThis.setInterval(syncSessions, 250)
    controller.add(() => globalThis.clearInterval(bindingRetryTimer))
    controller.add(() => {
      disposed = true
      for (const dispose of disposers.values())
        dispose()
      disposers.clear()
      snapshots.clear()
      reducerStates.clear()
    })
    syncSessions()
    return () => controller.dispose()
  }, PET_ACTIVITY_EFFECT)
}
