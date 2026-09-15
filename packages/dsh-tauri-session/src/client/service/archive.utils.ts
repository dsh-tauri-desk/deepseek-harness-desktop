export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** resync 挂起时不阻塞变更流程；计时器生命周期即本 Promise，无宿主资源。 */
// keep:effect resync 超时守护
export function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return Promise.race([promise, new Promise<void>(resolve => setTimeout(resolve, ms))])
}
