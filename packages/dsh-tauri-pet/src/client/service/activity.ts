import type { ClientContext } from 'dsh-tauri/client'
import { createLifecycleController } from 'dsh-tauri/client'
import { toTransferable } from '../utils/transferable'
import { pushPetSession } from './pet'

type SessionAction = 'create' | 'update' | 'remove'

interface RawSessionBinding {
  sessionId: string
  session: {
    getSnapshot: () => unknown
    subscribe: (listener: () => void) => () => void
  }
}

interface RawSessions {
  list: {
    getSnapshot: () => {
      byId?: Record<string, Record<string, unknown>>
      ids: readonly string[]
    }
    subscribe: (listener: () => void) => () => void
  }
  binding: (id: string) => RawSessionBinding | undefined
}

/**
 * 将 DSH 会话原始快照按生命周期推送给桌宠窗口，不生成宠物专用 projection。
 */
export function installPetSessionForwarder(ctx: ClientContext): void {
  ctx.effect(() => {
    const controller = createLifecycleController()
    const disposers = new Map<string, () => void>()
    const known = new Set<string>()
    let disposed = false

    function emit(action: SessionAction, session: Record<string, unknown>): void {
      if (disposed)
        return
      const payload = toTransferable(session) as Record<string, unknown>
      void pushPetSession(action, payload).catch((error) => {
        if (!disposed)
          console.error(`[dsh-tauri-pet] session ${action} push failed:`, error)
      })
    }

    const sessions = ctx.sessions as unknown as RawSessions

    function snapshotOf(id: string, binding: RawSessionBinding): Record<string, unknown> {
      const list = sessions.list.getSnapshot()
      const summary = list.byId?.[id]
      const snapshot = binding.session.getSnapshot()
      const value = snapshot && typeof snapshot === 'object'
        ? snapshot as Record<string, unknown>
        : { value: snapshot }
      return { id: binding.sessionId, ...(summary ?? {}), ...value }
    }

    function bind(id: string, action: SessionAction): void {
      const binding = sessions.binding(id)
      if (binding === undefined) {
        emit(action, { id })
        return
      }
      emit(action, snapshotOf(id, binding))
      disposers.set(id, binding.session.subscribe(() => emit('update', snapshotOf(id, binding))))
    }

    function sync(): void {
      const list = sessions.list.getSnapshot()
      const ids = new Set(list.ids)
      for (const id of known) {
        if (!ids.has(id)) {
          disposers.get(id)?.()
          disposers.delete(id)
          emit('remove', { id })
        }
      }
      for (const id of ids) {
        const binding = sessions.binding(id)
        if (binding === undefined) {
          if (!known.has(id))
            bind(id, 'create')
          continue
        }
        if (disposers.has(id))
          emit('update', snapshotOf(id, binding))
        else
          bind(id, known.has(id) ? 'update' : 'create')
      }
      known.clear()
      for (const id of ids)
        known.add(id)
    }

    controller.add(sessions.list.subscribe(sync))
    const retryTimer = globalThis.setInterval(sync, 250)
    controller.add(() => globalThis.clearInterval(retryTimer))
    controller.add(() => {
      disposed = true
      for (const dispose of disposers.values())
        dispose()
      disposers.clear()
      known.clear()
    })
    sync()
    return () => controller.dispose()
  }, 'dsh-tauri-pet: raw session events')
}
