import type { HostContext } from '../types'
import { defineHostRuntime } from 'dsh-tauri'

export const { setCurrentHostInstance, getCurrentHostInstance } = defineHostRuntime<HostContext>()

let writeQueue: Promise<unknown> = Promise.resolve()

export function withWriteQueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeQueue.then(() => fn())
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

export function clearHostRuntime(): void {
  writeQueue = Promise.resolve()
  setCurrentHostInstance(undefined)
}
