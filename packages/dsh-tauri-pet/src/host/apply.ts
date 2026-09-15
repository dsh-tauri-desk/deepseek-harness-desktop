import type { HostContext } from 'dsh-tauri'
import { PET_HOST_RUNTIME_EFFECT, PET_ROUTES_EFFECT } from './config/constants'
import { clearHostRuntime, setCurrentHostInstance } from './config/runtime'
import { routes } from './routes'

/**
 * host/apply.ts — 桌宠宿主侧装配。
 *
 * 方案 1（host → rust → pet webview）：宿主把 `session/event`【增量】总线状态化重建为
 * 桌宠展示态后，经 HTTP SSE 流发布；Rust 用 reqwest 订阅该流并 `emit_to('pet')`。
 */
export function apply(ctx: HostContext): void {
  setCurrentHostInstance(ctx)

  ctx.effect(() => routes(ctx), PET_ROUTES_EFFECT)
  ctx.effect(() => () => clearHostRuntime(), PET_HOST_RUNTIME_EFFECT)
}
