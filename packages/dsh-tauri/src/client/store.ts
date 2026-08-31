/**
 * Framework-neutral external state store.
 *
 * This store is intentionally independent of React and Cordis so it can be
 * shared by slot components, hydration/controllers, and DOM observers. React
 * consumers can connect it with `useSyncExternalStore`.
 *
 * State updates are immutable: callers return the next state instead of
 * mutating a draft. This avoids cloning the whole state tree for every update
 * and makes the ownership of each state transition explicit.
 */

export type StoreUpdater<T> = (current: T) => T
export type StoreValue<T> = T | StoreUpdater<T>
export type StoreListener = () => void

export interface ExternalStore<T> {
  /** Returns the same reference until a real state change is committed. */
  getSnapshot: () => T
  /** Subscribes to committed state changes and returns an unsubscribe function. */
  subscribe: (listener: StoreListener) => () => void
  /** Replaces the state, or derives the next state from the current state. */
  set: (next: StoreValue<T>) => void
}

/**
 * Creates a small external store for state shared across independent plugin
 * slots or non-React controllers.
 */
export function createExternalStore<T>(initial: T): ExternalStore<T> {
  let state = initial
  const listeners = new Set<StoreListener>()

  function set(next: StoreValue<T>): void {
    const nextState = typeof next === 'function'
      ? (next as StoreUpdater<T>)(state)
      : next

    // Besides avoiding needless React renders, this preserves the
    // useSyncExternalStore requirement that snapshots remain stable when
    // nothing observable changed.
    if (Object.is(nextState, state))
      return

    state = nextState
    notify()
  }

  function subscribe(listener: StoreListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function notify(): void {
    // Iterate over a snapshot so a listener may safely unsubscribe itself or
    // another listener while notification is in progress.
    for (const listener of [...listeners])
      listener()
  }

  function getSnapshot(): T {
    return state
  }

  return { getSnapshot, subscribe, set }
}

/**
 * A deliberately tiny signal for invalidating derived UI such as locale
 * revisions without allocating `{ rev: number }` snapshots.
 */
export interface RevisionSignal extends ExternalStore<number> {
  bump: () => void
}

export function createRevisionSignal(initial = 0): RevisionSignal {
  const store = createExternalStore(initial)
  return {
    ...store,
    bump: () => {
      store.set(revision => revision + 1)
    },
  }
}
